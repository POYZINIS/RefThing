//! Pyramid job handler (Phase 3): decodes an ingested image blob and
//! generates the WebP derivative levels (`thumb`/`small`/`medium`) via the
//! core pipeline, recording every level in `blob_derivatives`. `full` — and
//! any scaled level at or above the original's pixel size — aliases the
//! original bytes instead of re-encoding (never upscale), marked by
//! `format != 'image/webp'`.
//!
//! Idempotent by construction: derivative files are content-addressed and
//! rows are `INSERT OR REPLACE`d, so a replayed job redoes the work
//! harmlessly. On failure all rows are marked `failed` and the error is
//! returned so the queue's retry/backoff machinery takes over.

use std::path::Path;

use anyhow::Context as _;
use async_trait::async_trait;
use refthing_core::db::blobs;
use refthing_core::pipeline::{
    DerivativeRecord, ImageMetadata, PipelineError, extract_image_metadata, generate_pyramid,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::SqliteTransaction;
use uuid::Uuid;

use crate::events::hub::ServerMsg;

use super::{Job, JobContext, JobHandler};

/// Every level recorded in `blob_derivatives`, in pyramid order.
pub const ALL_LEVELS: [&str; 4] = ["thumb", "small", "medium", "full"];

/// Scaled (potentially generated) levels — everything except `full`.
const SCALED_LEVELS: [&str; 3] = ["thumb", "small", "medium"];

/// Enqueued by ingest, one per stored file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PyramidPayload {
    /// SHA-256 of the ingested blob (`blobs.hash` / blob-store key).
    pub blob_hash: String,
    /// MIME type sniffed at ingest.
    pub mime: String,
    /// Item the derivatives belong to.
    pub item_id: Uuid,
}

/// Generates the derivative pyramid for one image blob.
pub struct PyramidJob;

#[async_trait]
impl JobHandler for PyramidJob {
    async fn run(&self, ctx: &JobContext, job: &Job) -> anyhow::Result<()> {
        let payload: PyramidPayload =
            serde_json::from_value(job.payload.clone()).context("invalid pyramid payload")?;

        // Non-image payloads (video/audio/generic files) have no pyramid:
        // succeed without action so the job drains.
        if !payload.mime.starts_with("image/") {
            return Ok(());
        }

        mark_pending(ctx, &payload.blob_hash).await?;

        let original = ctx.blob_store.path(&payload.blob_hash);
        let blob_hash = payload.blob_hash.clone();
        let deriv_root = ctx.deriv_root.clone();
        let meta_path = original.clone();
        let result = ctx
            .resize_pool
            .run(move || {
                let full_dims = probe_dimensions(&original)?;
                let records = generate_pyramid(&original, &blob_hash, &deriv_root)?;
                let metadata = extract_image_metadata(&meta_path).ok();
                Ok::<_, PipelineError>((full_dims, records, metadata))
            })
            .await;

        match result {
            Ok((full_dims, records, metadata)) => {
                let levels = commit_ready(ctx, &payload, full_dims, &records).await?;
                // Persist dominant_colors + phash into item_metadata so the
                // frontend can filter by colour and detect near-duplicates.
                if let Some(meta) = metadata {
                    commit_metadata(ctx, &payload.item_id, &meta).await;
                }
                broadcast_ready(ctx, &payload, &levels).await;
                Ok(())
            }
            Err(error) => {
                mark_failed(ctx, &payload.blob_hash).await;
                Err(anyhow::Error::new(error).context("pyramid generation failed"))
            }
        }
    }
}

/// Header-only probe of the original's pixel dimensions, EXIF orientation
/// applied (orientations 5–8 swap the axes, matching the pipeline's
/// decode-then-orient). `DerivativeRecord`s only cover generated levels, so
/// the `full` row's dimensions have to come from here.
fn probe_dimensions(path: &Path) -> Result<(u32, u32), PipelineError> {
    use image::ImageDecoder as _;
    use image::metadata::Orientation;

    let mut decoder = image::ImageReader::open(path)?
        .with_guessed_format()?
        .into_decoder()?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let (width, height) = decoder.dimensions();
    let swapped = matches!(
        orientation,
        Orientation::Rotate90
            | Orientation::Rotate270
            | Orientation::Rotate90FlipH
            | Orientation::Rotate270FlipH
    );
    Ok(if swapped {
        (height, width)
    } else {
        (width, height)
    })
}

/// Marks all four levels `pending` before generation starts, so concurrent
/// `/blob` reads answer `X-Derivative: pending` instead of re-enqueueing.
/// Dimensions are placeholders until the ready rows replace them (the columns
/// are `NOT NULL`, hence the zeroes).
async fn mark_pending(ctx: &JobContext, hash: &str) -> anyhow::Result<()> {
    for level in ALL_LEVELS {
        sqlx::query(
            "INSERT OR REPLACE INTO blob_derivatives \
                 (blob_hash, level, width, height, byte_size, format, status) \
             VALUES (?, ?, 0, 0, 0, '', 'pending')",
        )
        .bind(hash)
        .bind(level)
        .execute(&ctx.pools.write)
        .await?;
    }
    Ok(())
}

/// Merges `dominant_colors` + phash into `item_metadata.json` for the item,
/// preserving any existing fields.  Silently ignored on DB errors (best-effort).
async fn commit_metadata(ctx: &JobContext, item_id: &uuid::Uuid, meta: &ImageMetadata) {
    let _ = sqlx::query(
        "INSERT INTO item_metadata (item_id, json) VALUES (?, ?)
         ON CONFLICT(item_id) DO UPDATE SET json = json_set(
             json,
             '$.dominant_colors', json_extract(excluded.json, '$.dominant_colors'),
             '$.phash', json_extract(excluded.json, '$.phash')
         )",
    )
    .bind(item_id)
    .bind(serde_json::to_string(meta).unwrap_or_default())
    .execute(&ctx.pools.write)
    .await;
}

/// One write-pool transaction: `ready` rows for every generated level, plus
/// the `full` row and alias rows for skipped levels — aliases share `full`'s
/// dimensions/byte size and carry the original MIME as their format. Also
/// backfills `blobs.width`/`height` when the ingest sniffer left them NULL.
///
/// Returns the ready level names for the `poster_ready` broadcast.
async fn commit_ready(
    ctx: &JobContext,
    payload: &PyramidPayload,
    full_dims: (u32, u32),
    records: &[DerivativeRecord],
) -> anyhow::Result<Vec<String>> {
    let blob = blobs::get(&ctx.pools.read, &payload.blob_hash)
        .await?
        .context("blob row vanished during pyramid job")?;
    let (full_width, full_height) = (i64::from(full_dims.0), i64::from(full_dims.1));

    let mut tx = ctx.pools.write.begin().await?;
    for record in records {
        insert_ready(
            &mut tx,
            &payload.blob_hash,
            record.level.as_str(),
            i64::from(record.width),
            i64::from(record.height),
            i64::try_from(record.byte_size)?,
            &record.format,
        )
        .await?;
    }

    // The full row itself, then one alias row per skipped scaled level.
    insert_ready(
        &mut tx,
        &payload.blob_hash,
        "full",
        full_width,
        full_height,
        blob.byte_size,
        &payload.mime,
    )
    .await?;
    for level in SCALED_LEVELS {
        let generated = records.iter().any(|r| r.level.as_str() == level);
        if !generated {
            insert_ready(
                &mut tx,
                &payload.blob_hash,
                level,
                full_width,
                full_height,
                blob.byte_size,
                &payload.mime,
            )
            .await?;
        }
    }

    sqlx::query(
        "UPDATE blobs SET width = ?, height = ? \
         WHERE hash = ? AND (width IS NULL OR height IS NULL)",
    )
    .bind(full_width)
    .bind(full_height)
    .bind(&payload.blob_hash)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(ALL_LEVELS
        .iter()
        .map(|level| (*level).to_string())
        .collect())
}

#[allow(clippy::too_many_arguments)]
async fn insert_ready(
    tx: &mut SqliteTransaction<'_>,
    hash: &str,
    level: &str,
    width: i64,
    height: i64,
    byte_size: i64,
    format: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT OR REPLACE INTO blob_derivatives \
             (blob_hash, level, width, height, byte_size, format, status) \
         VALUES (?, ?, ?, ?, ?, ?, 'ready')",
    )
    .bind(hash)
    .bind(level)
    .bind(width)
    .bind(height)
    .bind(byte_size)
    .bind(format)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Marks every derivative row `failed`. Best-effort: the job error is the
/// authoritative failure signal, so a DB hiccup here is only logged.
async fn mark_failed(ctx: &JobContext, hash: &str) {
    let result = sqlx::query("UPDATE blob_derivatives SET status = 'failed' WHERE blob_hash = ?")
        .bind(hash)
        .execute(&ctx.pools.write)
        .await;
    if let Err(error) = result {
        tracing::warn!(%error, hash, "failed to mark derivatives failed");
    }
}

/// Hot-swap notification for open boards. The item may have been deleted
/// between ingest and job completion — then there is no room to notify and
/// the broadcast is skipped.
async fn broadcast_ready(ctx: &JobContext, payload: &PyramidPayload, levels: &[String]) {
    let row: Option<(Uuid,)> = sqlx::query_as("SELECT board_id FROM items WHERE id = ?")
        .bind(payload.item_id)
        .fetch_optional(&ctx.pools.read)
        .await
        .ok()
        .flatten();
    if let Some((board_id,)) = row {
        ctx.hub.broadcast(
            board_id,
            ServerMsg::Job {
                kind: "poster_ready".to_string(),
                payload: json!({
                    "blob_hash": payload.blob_hash,
                    "item_id": payload.item_id,
                    "levels": levels,
                }),
            },
        );
    }
}
