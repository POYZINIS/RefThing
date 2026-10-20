//! Multipart ingestion: stream each file part straight into the blob store
//! (never buffering a whole file in memory), then commit ONE transaction per
//! file — blob row, item row, event row, and the `pyramid` job (outbox) land
//! atomically; workers are woken once, after the last commit.
//!
//! All SQL is runtime (`sqlx::query`) — see `item_service` for why.

use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use axum::body::Bytes;
use axum::extract::Multipart;
use axum::extract::multipart::Field;
use axum::http::StatusCode;
use futures_util::Stream;
use refthing_core::db::boards;
use refthing_core::models::Item as CoreItem;
use refthing_core::storage::BlobRef;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncRead, ReadBuf};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::events::append_event;
use crate::item_types;
use crate::jobs::pyramid::PyramidPayload;
use crate::services::item_service::{
    broadcast_gap, create_event_ops, json_codec_error, next_z_index, to_dto,
};
use crate::state::AppState;

/// Files without a `meta` position cascade down-right from the origin.
const CASCADE_STEP: f64 = 24.0;

/// Optional per-file placement from the `meta` part: `{x, y}`, either axis
/// independently optional (the missing axis cascades).
#[derive(Debug, Deserialize)]
struct MetaPos {
    x: Option<f64>,
    y: Option<f64>,
}

/// One ingested file in the 202 response. `poster` is `"pending"` until the
/// pyramid job lands derivatives (clients render `full` until then).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IngestedItem {
    pub item_id: Uuid,
    pub blob_hash: String,
    pub mime_type: String,
    pub width: f64,
    pub height: f64,
    /// `true` when the blob bytes were already in the store (same content
    /// hash); a fresh item row still points at the existing blob.
    pub dedup: bool,
    pub poster: &'static str,
    /// The created item and its blob, exactly as a snapshot would hold them:
    /// the client shows the file straight away, without refetching the board.
    pub item: crate::dto::Item,
    pub blob: Option<crate::dto::BlobInfo>,
}

/// 202 body: the board seq after the last committed file plus one entry per
/// file, in multipart order.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IngestResponse {
    pub seq: i64,
    pub items: Vec<IngestedItem>,
}

/// Handles `POST /api/boards/{id}/items:ingest`.
///
/// Two phases: stream every part (files go to the blob store as they arrive;
/// the optional `meta` part may come before or after them), then commit one
/// transaction per file. A crash between phases leaves at worst an
/// unreferenced blob, which the GC sweeps.
pub async fn ingest(
    state: &AppState,
    board_id: Uuid,
    mut multipart: Multipart,
) -> AppResult<IngestResponse> {
    let board = boards::get(&state.pools.read, board_id)
        .await?
        .ok_or(AppError::NotFound("board"))?;

    let mut positions: HashMap<String, MetaPos> = HashMap::new();
    let mut stored: Vec<(Option<String>, BlobRef)> = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| multipart_error(&error))?
    {
        if field.name() == Some("meta") {
            let text = field
                .text()
                .await
                .map_err(|error| multipart_error(&error))?;
            positions = serde_json::from_str(&text)
                .map_err(|error| AppError::BadRequest(format!("invalid meta part: {error}")))?;
        } else {
            let filename = field.file_name().map(str::to_string);
            let blob = state.blob_store.put(FieldReader::new(field)).await?;
            stored.push((filename, blob));
        }
    }

    let mut seq = board.seq;
    let mut items = Vec::with_capacity(stored.len());
    let mut cascade = 0.0_f64;
    for (filename, blob) in stored {
        let position = filename.as_deref().and_then(|name| positions.get(name));
        let (x, y, used_cascade) = match position {
            Some(pos) => (
                pos.x.unwrap_or(cascade),
                pos.y.unwrap_or(cascade),
                pos.x.is_none() || pos.y.is_none(),
            ),
            None => (cascade, cascade, true),
        };
        if used_cascade {
            cascade += CASCADE_STEP;
        }
        let landing = Landing {
            x,
            y,
            ..Landing::default()
        };
        let (new_seq, item) = commit_file(state, board_id, filename, &blob, &landing).await?;
        seq = new_seq;
        items.push(item);
    }
    if !items.is_empty() {
        state.jobs.notify();
    }
    Ok(IngestResponse { seq, items })
}

/// A stored blob with no item of its own (a 3D model's texture, referenced
/// from the item's metadata instead).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredBlob {
    pub hash: String,
    pub mime_type: String,
    pub byte_size: u64,
}

/// Handles `POST /api/blobs`: the first file part goes into the blob store
/// and the registry (idempotent, like ingest), with no item. Images only —
/// these are textures.
pub async fn store_blob(state: &AppState, mut multipart: Multipart) -> AppResult<StoredBlob> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| multipart_error(&error))?
    {
        if field.file_name().is_none() {
            continue;
        }
        let filename = field.file_name().map(str::to_string);
        let blob = state.blob_store.put(FieldReader::new(field)).await?;
        if !blob.mime.starts_with("image/") {
            return Err(AppError::UnsupportedMedia(blob.mime));
        }
        let stored = state.blob_store.path(&blob.hash);
        let dims = tokio::task::spawn_blocking(move || {
            crate::jobs::pyramid::probe_dimensions(&stored).ok()
        })
        .await
        .ok()
        .flatten();
        let byte_size = i64::try_from(blob.byte_size)
            .map_err(|error| AppError::BadRequest(format!("blob too large: {error}")))?;
        sqlx::query(
            "INSERT OR IGNORE INTO blobs \
                 (hash, original_filename, mime_type, byte_size, width, height) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&blob.hash)
        .bind(filename.as_deref())
        .bind(&blob.mime)
        .bind(byte_size)
        .bind(dims.map(|(width, _)| i64::from(width)))
        .bind(dims.map(|(_, height)| i64::from(height)))
        .execute(&state.pools.write)
        .await?;
        return Ok(StoredBlob {
            hash: blob.hash,
            mime_type: blob.mime,
            byte_size: blob.byte_size,
        });
    }
    Err(AppError::BadRequest("no file part".to_string()))
}

/// Where a committed file lands on its board.
#[derive(Debug, Clone, Default)]
pub(crate) struct Landing {
    /// Top-left of the frame.
    pub x: f64,
    pub y: f64,
    /// Frame size; `None` places it at the type handler's size (the file's
    /// true proportions).
    pub size: Option<(f64, f64)>,
    /// Clockwise degrees about the frame's centre.
    pub rotation: f64,
    /// Item metadata keys (crop, flip, opacity) merged over the probe's.
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

/// One atomic commit per file: blob registry row (idempotent), item row,
/// event row, and the `pyramid` job in the same transaction (true outbox).
pub(crate) async fn commit_file(
    state: &AppState,
    board_id: Uuid,
    filename: Option<String>,
    blob: &BlobRef,
    landing: &Landing,
) -> AppResult<(i64, IngestedItem)> {
    // Route by sniffed MIME (Phase 11 item type handlers). Probing reads the
    // stored file's header (or ffprobe for media) BEFORE the transaction, so
    // the item is placed at its true proportions — `infer` sniffs no sizes,
    // and a fixed placeholder squashed every non-square image into a square.
    let stored = state.blob_store.path(&blob.hash);
    let mime = refined_mime(&stored, &blob.mime, filename.as_deref()).await;
    let handler = item_types::handler_for(&mime);
    let probe = handler.probe(&stored).await;
    let (width, height) = landing
        .size
        .unwrap_or_else(|| handler.placement(probe.as_ref()));

    let mut tx = state.pools.write.begin().await?;

    let byte_size = i64::try_from(blob.byte_size)
        .map_err(|error| AppError::BadRequest(format!("blob too large: {error}")))?;
    let inserted = sqlx::query(
        "INSERT OR IGNORE INTO blobs \
             (hash, original_filename, mime_type, byte_size, width, height) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&blob.hash)
    .bind(filename.as_deref())
    .bind(&mime)
    .bind(byte_size)
    .bind(probe.as_ref().map(|probe| i64::from(probe.width)))
    .bind(probe.as_ref().map(|probe| i64::from(probe.height)))
    .execute(&mut *tx)
    .await?;
    let dedup = inserted.rows_affected() == 0;
    if dedup && mime != blob.mime {
        adopt_refined_mime(&mut tx, &blob.hash, &mime).await?;
    }

    let z_index = next_z_index(&mut tx, board_id).await?;
    let item_id = Uuid::now_v7();
    let row = sqlx::query_as::<_, CoreItem>(
        "INSERT INTO items \
             (id, board_id, type, blob_id, x, y, width, height, rotation, z_index, group_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) RETURNING *",
    )
    .bind(item_id)
    .bind(board_id)
    .bind(handler.item_type())
    .bind(&blob.hash)
    .bind(landing.x)
    .bind(landing.y)
    .bind(width)
    .bind(height)
    .bind(landing.rotation)
    .bind(z_index)
    .fetch_one(&mut *tx)
    .await?;

    // Type metadata (e.g. media duration) rides in item_metadata, with the
    // landing's own keys (an import's crop / flip / opacity) over it.
    let mut metadata = probe.map_or_else(|| json!({}), |probe| probe.metadata);
    if let (Some(extra), Some(fields)) = (&landing.metadata, metadata.as_object_mut()) {
        fields.extend(extra.clone());
    }
    if metadata
        .as_object()
        .is_some_and(|fields| !fields.is_empty())
    {
        sqlx::query("INSERT INTO item_metadata (item_id, json) VALUES (?, ?)")
            .bind(item_id)
            .bind(metadata.to_string())
            .execute(&mut *tx)
            .await?;
    }
    let item = to_dto(row, metadata);
    let ops = create_event_ops(&item)?;
    let created = item.clone();
    let seq = append_event(&mut tx, board_id, None, &ops).await?;

    if let Some(job) = handler.poster_job() {
        let payload = PyramidPayload {
            blob_hash: blob.hash.clone(),
            mime: mime.clone(),
            item_id,
        };
        state
            .jobs
            .enqueue_tx(
                &mut tx,
                job,
                serde_json::to_value(&payload).map_err(json_codec_error)?,
            )
            .await?;
    }

    tx.commit().await?;
    broadcast_gap(state, board_id, seq);
    let blob_info =
        crate::services::board_service::blob_info(&state.pools.read, &blob.hash).await?;

    Ok((
        seq,
        IngestedItem {
            item_id,
            blob_hash: blob.hash.clone(),
            mime_type: mime,
            width,
            height,
            dedup,
            poster: "pending",
            item: created,
            blob: blob_info,
        },
    ))
}

/// Maps a multipart failure onto the error enum, preserving axum's 413.
fn multipart_error(error: &axum::extract::multipart::MultipartError) -> AppError {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        AppError::TooLarge
    } else {
        AppError::BadRequest(error.to_string())
    }
}

/// Adapts a multipart field's chunk stream to [`AsyncRead`] so
/// [`BlobStore::put`](refthing_core::storage::BlobStore::put) hashes and
/// places the file in one streaming pass.
struct FieldReader<'a> {
    field: Pin<Box<Field<'a>>>,
    chunk: Bytes,
    offset: usize,
}

impl<'a> FieldReader<'a> {
    fn new(field: Field<'a>) -> Self {
        Self {
            field: Box::pin(field),
            chunk: Bytes::new(),
            offset: 0,
        }
    }
}

impl AsyncRead for FieldReader<'_> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        loop {
            if this.offset < this.chunk.len() {
                let take = (this.chunk.len() - this.offset).min(buf.remaining());
                buf.put_slice(&this.chunk[this.offset..this.offset + take]);
                this.offset += take;
                return Poll::Ready(Ok(()));
            }
            match this.field.as_mut().poll_next(cx) {
                Poll::Ready(Some(Ok(chunk))) => {
                    this.chunk = chunk;
                    this.offset = 0;
                }
                Poll::Ready(Some(Err(error))) => {
                    return Poll::Ready(Err(io::Error::other(error)));
                }
                // Clean end of the part: EOF, no bytes written.
                Poll::Ready(None) => return Poll::Ready(Ok(())),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

/// The stored file's type, refined past the general sniffer (3D models and
/// some audio: magic bytes, then the extension — see
/// `item_types::refine_mime`; audio in a video container: its track list).
pub(crate) async fn refined_mime(
    stored: &std::path::Path,
    sniffed: &str,
    filename: Option<&str>,
) -> String {
    use tokio::io::AsyncReadExt;
    let mut head = vec![0u8; 32];
    let read = match tokio::fs::File::open(stored).await {
        Ok(mut file) => file.read(&mut head).await.unwrap_or(0),
        Err(_) => 0,
    };
    head.truncate(read);
    let refined = item_types::refine_mime(sniffed, filename, &head);
    let path = stored.to_path_buf();
    let container = refined.clone();
    let audio =
        tokio::task::spawn_blocking(move || item_types::audio_container_mime(&container, &path))
            .await
            .ok()
            .flatten();
    audio.map_or(refined, str::to_string)
}

/// A blob stored before its type was recognized (a model dropped before 3D
/// support, audio filed as a video by its container) takes the refined type
/// when it's ingested again.
async fn adopt_refined_mime(
    tx: &mut sqlx::SqliteTransaction<'_>,
    hash: &str,
    mime: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE blobs SET mime_type = ?1 WHERE hash = ?2 AND (mime_type = 'application/octet-stream' \
         OR (?1 LIKE 'audio/%' AND mime_type LIKE 'video/%'))",
    )
    .bind(mime)
    .bind(hash)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
