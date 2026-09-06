//! Blob byte serving: `GET /blob/{hash}/{level}`.
//!
//! `full` is the original bytes streamed from the content-addressed store
//! (never buffered whole). The scaled levels (`thumb`/`small`/`medium`) come
//! from the Phase 3 pyramid job: a `ready` `blob_derivatives` row serves the
//! generated WebP at `<data_dir>/deriv/<ab>/<cd>/<hash>/<level>.webp`, or —
//! for alias rows (level ≥ original size, `format != 'image/webp'`) — the
//! original bytes. `pending` (or missing) rows answer `404` +
//! `X-Derivative: pending` and single-flight re-enqueue the pyramid job as a
//! backstop; `failed` rows answer `404` + `X-Derivative: failed`. The
//! frontend learns available levels from the `BoardSnapshot` and the
//! `poster_ready` WS message — no probing loop.
//!
//! All responses carry immutable caching and a strong `ETag`
//! (`"{hash}-{level}"`): every URL is content-addressed, so bytes never
//! change. No compression layer touches these bytes (see `router.rs`).

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Router, routing::get};
use futures_util::stream;
use refthing_core::db::blobs;
use refthing_core::models::Blob;
use tokio::io::AsyncReadExt;

use crate::error::{AppError, AppResult};
use crate::jobs::pyramid::PyramidPayload;
use crate::state::AppState;

/// Immutable forever: the URL is content-addressed, so bytes never change.
const FULL_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const READ_CHUNK: usize = 64 * 1024;
const DERIVATIVE_MIME: &str = "image/webp";

pub fn router() -> Router<AppState> {
    Router::new().route("/blob/{hash}/{level}", get(get_blob))
}

async fn get_blob(
    State(state): State<AppState>,
    Path((hash, level)): Path<(String, String)>,
    headers: HeaderMap,
) -> AppResult<Response> {
    if !matches!(level.as_str(), "thumb" | "small" | "medium" | "full") {
        return Err(AppError::NotFound("blob level"));
    }
    let blob = blobs::get(&state.pools.read, &hash)
        .await?
        .ok_or(AppError::NotFound("blob"))?;

    // `full` is the passthrough level: the original bytes always exist, even
    // while the pyramid job is still running (or for pre-Phase-3 blobs with
    // no derivative rows at all).
    if level == "full" {
        return serve_original(&state, &hash, &level, &blob, &headers).await;
    }

    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT status, format FROM blob_derivatives WHERE blob_hash = ? AND level = ?",
    )
    .bind(&hash)
    .bind(&level)
    .fetch_optional(&state.pools.read)
    .await?;

    match row {
        Some((status, format)) if status == "ready" => {
            // Alias rows (level ≥ original size) point at the original bytes.
            if format.as_deref() == Some(DERIVATIVE_MIME) {
                serve_derivative(&state, &hash, &level, &headers).await
            } else {
                serve_original(&state, &hash, &level, &blob, &headers).await
            }
        }
        Some((status, _)) if status == "failed" => Ok(derivative_unavailable(&level, "failed")),
        // Pending or missing row: nudge the pipeline (single-flight) so a
        // missed/crashed job self-heals, and tell the client to fall back.
        _ => {
            reenqueue_pyramid(&state, &hash, &blob).await;
            Ok(derivative_unavailable(&level, "pending"))
        }
    }
}

/// Streams the original blob with the level-scoped `ETag` (an alias level and
/// `full` share bytes but not URLs, so their cache keys may differ).
async fn serve_original(
    state: &AppState,
    hash: &str,
    level: &str,
    blob: &Blob,
    headers: &HeaderMap,
) -> AppResult<Response> {
    let etag = format!("\"{hash}-{level}\"");
    if if_none_match_matches(headers, &etag) {
        return Ok(not_modified(&etag));
    }
    let file = state.blob_store.open(hash).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound("blob")
        } else {
            AppError::Io(error)
        }
    })?;
    Ok(stream_response(
        file,
        &etag,
        &blob.mime_type,
        blob.byte_size,
    ))
}

/// Streams a generated WebP derivative from the deriv shard.
async fn serve_derivative(
    state: &AppState,
    hash: &str,
    level: &str,
    headers: &HeaderMap,
) -> AppResult<Response> {
    let etag = format!("\"{hash}-{level}\"");
    if if_none_match_matches(headers, &etag) {
        return Ok(not_modified(&etag));
    }
    let path = derivative_path(state, hash, level);
    let file = tokio::fs::File::open(&path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound("derivative")
        } else {
            AppError::Io(error)
        }
    })?;
    let byte_size = i64::try_from(file.metadata().await?.len())
        .map_err(|error| AppError::BadRequest(format!("derivative too large: {error}")))?;
    Ok(stream_response(file, &etag, DERIVATIVE_MIME, byte_size))
}

/// `<data_dir>/deriv/<hash[0..2]>/<hash[2..4]>/<hash>/<level>.webp` — the
/// layout the pyramid job writes to.
fn derivative_path(state: &AppState, hash: &str, level: &str) -> std::path::PathBuf {
    state
        .config
        .data_dir
        .join("deriv")
        .join(&hash[0..2])
        .join(&hash[2..4])
        .join(hash)
        .join(format!("{level}.webp"))
}

/// Backstop for a missed or crashed pyramid job: enqueue one, unless a
/// pending/running job for this blob already exists. The `INSERT ... WHERE
/// NOT EXISTS` runs as a single statement on the single-connection write
/// pool, which makes the dedupe check-and-insert atomic. Best-effort: a
/// failure here must not break the 404 contract, so it is only logged.
async fn reenqueue_pyramid(state: &AppState, hash: &str, blob: &Blob) {
    if !blob.mime_type.starts_with("image/") {
        return; // non-image blobs never produce derivatives
    }
    let item: Option<(uuid::Uuid,)> =
        sqlx::query_as("SELECT id FROM items WHERE blob_id = ? LIMIT 1")
            .bind(hash)
            .fetch_optional(&state.pools.read)
            .await
            .ok()
            .flatten();
    let Some((item_id,)) = item else {
        return; // unreferenced blob: nothing to notify, GC will sweep it
    };

    let payload = PyramidPayload {
        blob_hash: hash.to_string(),
        mime: blob.mime_type.clone(),
        item_id,
    };
    let payload_json = match serde_json::to_string(&payload) {
        Ok(json) => json,
        Err(error) => {
            tracing::warn!(%error, hash, "pyramid re-enqueue payload failed to serialize");
            return;
        }
    };
    let result = sqlx::query(
        "INSERT INTO jobs (kind, payload_json) \
         SELECT 'pyramid', ? \
         WHERE NOT EXISTS ( \
             SELECT 1 FROM jobs \
             WHERE kind = 'pyramid' AND status IN ('pending', 'running') \
               AND json_extract(payload_json, '$.blob_hash') = ? \
         )",
    )
    .bind(payload_json)
    .bind(hash)
    .execute(&state.pools.write)
    .await;
    match result {
        Ok(done) if done.rows_affected() > 0 => {
            tracing::info!(hash, "re-enqueued missing pyramid job");
            state.jobs.notify();
        }
        Ok(_) => {} // another request or the queue beat us to it
        Err(error) => tracing::warn!(%error, hash, "pyramid re-enqueue failed"),
    }
}

/// Streams the blob in [`READ_CHUNK`] pieces; the file handle travels with the
/// stream so the whole file is never resident in memory.
fn stream_response(file: tokio::fs::File, etag: &str, mime_type: &str, byte_size: i64) -> Response {
    let chunks = stream::try_unfold((file, vec![0u8; READ_CHUNK]), |(mut file, mut buf)| async {
        match file.read(&mut buf).await {
            Ok(0) => Ok(None),
            Ok(n) => Ok(Some((Bytes::copy_from_slice(&buf[..n]), (file, buf)))),
            Err(error) => Err(error),
        }
    });

    let mut response = Body::from_stream(chunks).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime_type)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&byte_size.to_string())
            .unwrap_or_else(|_| HeaderValue::from_static("0")),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(FULL_CACHE_CONTROL),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    // `hash` comes from a registered blob row, so it is always 64-char hex.
    if let Ok(value) = HeaderValue::from_str(etag) {
        headers.insert(header::ETAG, value);
    }
    response
}

/// 404 with `X-Derivative: {status}` tells the frontend to fall back to a
/// ready level (pending) or give up (failed) without probing.
fn derivative_unavailable(level: &str, status: &'static str) -> Response {
    debug_assert!(matches!(level, "thumb" | "small" | "medium"));
    let reason = if status == "failed" {
        "derivative (pyramid job failed)"
    } else {
        "derivative (pyramid job pending)"
    };
    let mut response = AppError::NotFound(reason).into_response();
    response.headers_mut().insert(
        header::HeaderName::from_static("x-derivative"),
        HeaderValue::from_static(status),
    );
    response
}

/// 304 keeps the caching headers so clients can extend their freshness.
fn not_modified(etag: &str) -> Response {
    let mut response = StatusCode::NOT_MODIFIED.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(FULL_CACHE_CONTROL),
    );
    if let Ok(value) = HeaderValue::from_str(etag) {
        headers.insert(header::ETAG, value);
    }
    response
}

/// Strong comparison per RFC 9110: exact match on any list member, or `*`.
fn if_none_match_matches(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .map(str::trim)
                .any(|candidate| candidate == "*" || candidate == etag)
        })
}
