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
use crate::jobs::pyramid::PyramidPayload;
use crate::services::item_service::{
    broadcast_gap, create_event_ops, json_codec_error, next_z_index, to_dto,
};
use crate::state::AppState;

/// Files without a `meta` position cascade down-right from the origin.
const CASCADE_STEP: f64 = 24.0;
/// Placeholder edge until the Phase 3 pyramid pipeline measures real
/// dimensions (`infer` sniffs no sizes, so `BlobRef::width/height` are `None`).
const DEFAULT_EDGE: f64 = 256.0;

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
        let (new_seq, item) = commit_file(state, board_id, filename, &blob, x, y).await?;
        seq = new_seq;
        items.push(item);
    }
    if !items.is_empty() {
        state.jobs.notify();
    }
    Ok(IngestResponse { seq, items })
}

/// One atomic commit per file: blob registry row (idempotent), item row,
/// event row, and the `pyramid` job in the same transaction (true outbox).
async fn commit_file(
    state: &AppState,
    board_id: Uuid,
    filename: Option<String>,
    blob: &BlobRef,
    x: f64,
    y: f64,
) -> AppResult<(i64, IngestedItem)> {
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
    .bind(&blob.mime)
    .bind(byte_size)
    .bind(blob.width.map(i64::from))
    .bind(blob.height.map(i64::from))
    .execute(&mut *tx)
    .await?;
    let dedup = inserted.rows_affected() == 0;

    let width = blob.width.map_or(DEFAULT_EDGE, f64::from);
    let height = blob.height.map_or(DEFAULT_EDGE, f64::from);
    let z_index = next_z_index(&mut tx, board_id).await?;
    let item_id = Uuid::now_v7();
    let row = sqlx::query_as::<_, CoreItem>(
        "INSERT INTO items \
             (id, board_id, type, blob_id, x, y, width, height, rotation, z_index, group_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL) RETURNING *",
    )
    .bind(item_id)
    .bind(board_id)
    .bind(item_type_for(&blob.mime))
    .bind(&blob.hash)
    .bind(x)
    .bind(y)
    .bind(width)
    .bind(height)
    .bind(z_index)
    .fetch_one(&mut *tx)
    .await?;

    let item = to_dto(row, json!({}));
    let ops = create_event_ops(&item)?;
    let seq = append_event(&mut tx, board_id, None, &ops).await?;

    let payload = PyramidPayload {
        blob_hash: blob.hash.clone(),
        mime: blob.mime.clone(),
        item_id,
    };
    state
        .jobs
        .enqueue_tx(
            &mut tx,
            "pyramid",
            serde_json::to_value(&payload).map_err(json_codec_error)?,
        )
        .await?;

    tx.commit().await?;
    broadcast_gap(state, board_id, seq);

    Ok((
        seq,
        IngestedItem {
            item_id,
            blob_hash: blob.hash.clone(),
            mime_type: blob.mime.clone(),
            width,
            height,
            dedup,
            poster: "pending",
        },
    ))
}

/// Coarse item type from the sniffed MIME; unknown types land as `file` and
/// get the generic-file poster (see `docs/data-model.md`).
fn item_type_for(mime: &str) -> &'static str {
    if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("video/") {
        "video"
    } else if mime.starts_with("audio/") {
        "audio"
    } else {
        "file"
    }
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
