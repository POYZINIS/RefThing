//! Poster job for video and audio items (plan Phase 11: poster mode).
//!
//! Video: ffmpeg renders one frame. Audio: `RefThing`'s own waveform tile
//! (`refthing_core::pipeline::waveform`), from the file decoded natively —
//! WAV, AIFF, CAF, FLAC, MP3, Ogg Vorbis, AAC/M4A, ALAC, Matroska/WebM — or,
//! for codecs with no native decoder (Opus, WMA, AC-3, AMR …), from the
//! samples ffmpeg decodes. Either still goes through the image pyramid into
//! the usual thumb/small/medium derivatives, so the canvas draws media
//! posters exactly like images. `full` keeps serving the original media
//! bytes for live playback.
//!
//! Best-effort: a file nothing can read (or a video without ffmpeg) gets no
//! derivatives, and the client draws a card poster instead.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::Context as _;
use async_trait::async_trait;
use refthing_core::db::Pools;
use refthing_core::pipeline::generate_poster_pyramid;
use refthing_core::pipeline::waveform::{
    Envelope, EnvelopeBuilder, WAVEFORM_REV, decode_envelope, render_tile,
};
use refthing_core::storage::BlobStore;
use tokio::io::AsyncReadExt;
use uuid::Uuid;

use super::pyramid::{
    PyramidPayload, broadcast_ready, commit_ready, mark_failed, mark_pending, probe_dimensions,
};
use super::{Job, JobContext, JobHandler, JobQueue};
use crate::item_types::tool;

/// The longest ffmpeg may take to hand over a file's samples.
const FFMPEG_DECODE_LIMIT: Duration = Duration::from_secs(180);
/// ffmpeg's samples for a waveform: mono at a low rate (plenty for a
/// [`refthing_core::pipeline::waveform::BARS`]-bar envelope).
const FFMPEG_RATE: &str = "8000";

pub struct MediaPosterJob;

#[async_trait]
impl JobHandler for MediaPosterJob {
    async fn run(&self, ctx: &JobContext, job: &Job) -> anyhow::Result<()> {
        let payload: PyramidPayload =
            serde_json::from_value(job.payload.clone()).context("invalid poster payload")?;
        let original = ctx.blob_store.path(&payload.blob_hash);
        let still = ctx
            .deriv_root
            .join(format!("{}.poster.png", payload.blob_hash));
        if let Some(parent) = still.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let (rendered, rev) = if payload.mime.starts_with("video/") {
            // A second in avoids black lead-in frames; very short clips fall
            // back to their first frame.
            let frame = render(&original, &still, &["-ss", "1"], &["-frames:v", "1"]).await
                || render(&original, &still, &[], &["-frames:v", "1"]).await;
            (frame, 0)
        } else {
            (draw_waveform(&original, &still).await, WAVEFORM_REV)
        };
        if !rendered {
            tracing::info!(hash = %payload.blob_hash, "no media poster (unreadable file, or ffmpeg needed and missing)");
            return Ok(());
        }

        mark_pending(ctx, &payload.blob_hash).await?;
        let blob_hash = payload.blob_hash.clone();
        let deriv_root = ctx.deriv_root.clone();
        let source = still.clone();
        let result = ctx
            .resize_pool
            .run(move || {
                let dims = probe_dimensions(&source)?;
                let records = generate_poster_pyramid(&source, &blob_hash, &deriv_root)?;
                Ok::<_, refthing_core::pipeline::PipelineError>((dims, records))
            })
            .await;
        let _ = tokio::fs::remove_file(&still).await;
        match result {
            Ok((dims, records)) => {
                let levels = commit_ready(ctx, &payload, dims, &records, rev).await?;
                broadcast_ready(ctx, &payload, &levels, rev).await;
                Ok(())
            }
            Err(error) => {
                mark_failed(ctx, &payload.blob_hash).await;
                Err(anyhow::Error::new(error).context("media poster pyramid failed"))
            }
        }
    }
}

/// The waveform tile as a PNG at `output`: decoded natively, else from
/// ffmpeg's samples. True on success.
async fn draw_waveform(input: &Path, output: &Path) -> bool {
    let source = input.to_path_buf();
    let native = tokio::task::spawn_blocking(move || decode_envelope(&source, None)).await;
    let envelope = match native {
        Ok(Ok(envelope)) => envelope,
        Ok(Err(reason)) => {
            tracing::debug!(%reason, "no native decoder; asking ffmpeg");
            let Some(envelope) = ffmpeg_envelope(input).await else {
                return false;
            };
            envelope
        }
        Err(_) => return false,
    };
    let output = output.to_path_buf();
    tokio::task::spawn_blocking(move || render_tile(&envelope).save(&output).is_ok())
        .await
        .unwrap_or(false)
}

/// The envelope from ffmpeg's decoded samples (mono 32-bit float, streamed
/// — an hour of audio is never held whole); `None` without ffmpeg or when
/// it can't read the file.
async fn ffmpeg_envelope(input: &Path) -> Option<Envelope> {
    let mut child = tokio::process::Command::new(tool("ffmpeg"))
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(input)
        .args([
            "-vn",
            "-ac",
            "1",
            "-ar",
            FFMPEG_RATE,
            "-f",
            "f32le",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let mut builder = EnvelopeBuilder::new(None);
    let read = async {
        let mut chunk = vec![0u8; 64 * 1024];
        let mut pending: Vec<u8> = Vec::new();
        let mut samples: Vec<f32> = Vec::new();
        loop {
            let count = stdout.read(&mut chunk).await?;
            if count == 0 {
                break;
            }
            pending.extend_from_slice(&chunk[..count]);
            let whole = pending.len() / 4 * 4;
            samples.clear();
            samples.extend(
                pending[..whole]
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .map(|bytes| f32::from_le_bytes(*bytes)),
            );
            builder.push_interleaved(&samples, 1);
            pending.drain(..whole);
        }
        Ok::<_, std::io::Error>(())
    };
    tokio::time::timeout(FFMPEG_DECODE_LIMIT, read)
        .await
        .ok()?
        .ok()?;
    let status = child.wait().await.ok()?;
    if !status.success() {
        return None;
    }
    builder.finish()
}

/// Run ffmpeg to write one PNG still; true on success.
async fn render(
    input: &Path,
    output: &PathBuf,
    before_input: &[&str],
    after_input: &[&str],
) -> bool {
    let run = tokio::process::Command::new(tool("ffmpeg"))
        .args(["-v", "error", "-y"])
        .args(before_input)
        .arg("-i")
        .arg(input)
        .args(after_input)
        .arg(output)
        .kill_on_drop(true)
        .status();
    matches!(
        tokio::time::timeout(Duration::from_secs(60), run).await,
        Ok(Ok(status)) if status.success()
    ) && tokio::fs::metadata(output)
        .await
        .is_ok_and(|meta| meta.len() > 0)
}

/// Audio filed before it was recognized — a `.weba` / `.mka` / `.wma` taken
/// for a video by its container, a `.caf` or `.ac3` left a file card —
/// becomes an audio item, keeping its place and width at the waveform's
/// proportions. Runs at startup; returns how many items changed.
///
/// # Errors
/// Database failures.
pub async fn retype_audio(pools: &Pools, blob_store: &BlobStore) -> Result<u64, sqlx::Error> {
    let candidates: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT DISTINCT b.hash, b.mime_type, b.original_filename \
         FROM items i JOIN blobs b ON b.hash = i.blob_id WHERE i.type IN ('file', 'video')",
    )
    .fetch_all(&pools.read)
    .await?;
    let mut changed = 0;
    for (hash, mime, filename) in candidates {
        let path = blob_store.path(&hash);
        let refined =
            crate::services::ingest_service::refined_mime(&path, &mime, filename.as_deref()).await;
        if !refined.starts_with("audio/") {
            continue;
        }
        let mut tx = pools.write.begin().await?;
        sqlx::query("UPDATE blobs SET mime_type = ? WHERE hash = ?")
            .bind(&refined)
            .bind(&hash)
            .execute(&mut *tx)
            .await?;
        let items = sqlx::query(
            "UPDATE items SET type = 'audio', height = width / 4.0 \
             WHERE blob_id = ? AND type IN ('file', 'video')",
        )
        .bind(&hash)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        changed += items.rows_affected();
    }
    Ok(changed)
}

/// Audio whose poster is missing, or was drawn by an older waveform renderer
/// (ffmpeg's, before 0.3.2), gets a poster job — one per stored file, unless
/// one is already waiting. Runs at startup; returns how many were queued.
///
/// # Errors
/// Database failures.
pub async fn queue_waveforms(pools: &Pools, jobs: &JobQueue) -> Result<usize, sqlx::Error> {
    let outdated: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT MIN(i.id), b.hash, b.mime_type FROM items i JOIN blobs b ON b.hash = i.blob_id \
         WHERE i.type = 'audio' \
           AND NOT EXISTS (SELECT 1 FROM blob_derivatives d WHERE d.blob_hash = b.hash \
                           AND d.level = 'thumb' AND d.status = 'ready' AND d.rev >= ?) \
           AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.kind = 'media_poster' \
                           AND j.status IN ('pending', 'running') \
                           AND json_extract(j.payload_json, '$.blob_hash') = b.hash) \
         GROUP BY b.hash",
    )
    .bind(WAVEFORM_REV)
    .fetch_all(&pools.read)
    .await?;
    for (item_id, blob_hash, mime) in &outdated {
        let payload = serde_json::to_value(PyramidPayload {
            blob_hash: blob_hash.clone(),
            mime: mime.clone(),
            item_id: *item_id,
        })
        .unwrap_or_default();
        jobs.enqueue("media_poster", payload).await?;
    }
    if !outdated.is_empty() {
        jobs.notify();
    }
    Ok(outdated.len())
}
