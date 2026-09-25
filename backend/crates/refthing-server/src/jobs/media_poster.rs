//! Poster job for video and audio items (plan Phase 11: poster mode).
//!
//! ffmpeg renders one still — a frame for video, a waveform strip for audio —
//! and the image pyramid pipeline turns it into the usual thumb/small/medium
//! derivatives, so the canvas draws media posters exactly like images. `full`
//! keeps serving the original media bytes for live playback.
//!
//! Best-effort: without ffmpeg (or on a file it can't read) the job succeeds
//! without derivatives and the client draws a card poster instead.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Context as _;
use async_trait::async_trait;
use refthing_core::pipeline::generate_pyramid;

use super::pyramid::{
    PyramidPayload, broadcast_ready, commit_ready, mark_failed, mark_pending, probe_dimensions,
};
use super::{Job, JobContext, JobHandler};
use crate::item_types::tool;

/// Waveform strip size for audio posters (px).
const WAVEFORM: &str = "1600x400";

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
        let rendered = if payload.mime.starts_with("video/") {
            // A second in avoids black lead-in frames; very short clips fall
            // back to their first frame.
            render(&original, &still, &["-ss", "1"], &["-frames:v", "1"]).await
                || render(&original, &still, &[], &["-frames:v", "1"]).await
        } else {
            render(
                &original,
                &still,
                &[],
                &[
                    "-filter_complex",
                    &format!(
                        "aformat=channel_layouts=mono,showwavespic=s={WAVEFORM}:colors=0xd6ff76"
                    ),
                    "-frames:v",
                    "1",
                ],
            )
            .await
        };
        if !rendered {
            tracing::info!(hash = %payload.blob_hash, "no media poster (ffmpeg unavailable or unreadable file)");
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
                let records = generate_pyramid(&source, &blob_hash, &deriv_root)?;
                Ok::<_, refthing_core::pipeline::PipelineError>((dims, records))
            })
            .await;
        let _ = tokio::fs::remove_file(&still).await;
        match result {
            Ok((dims, records)) => {
                let levels = commit_ready(ctx, &payload, dims, &records).await?;
                broadcast_ready(ctx, &payload, &levels).await;
                Ok(())
            }
            Err(error) => {
                mark_failed(ctx, &payload.blob_hash).await;
                Err(anyhow::Error::new(error).context("media poster pyramid failed"))
            }
        }
    }
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
