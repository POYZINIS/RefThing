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
//! Originals honor a single `Range: bytes=…` request (206 / 416) so video
//! and audio items can seek in live mode (Phase 11).
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
use tokio::io::{AsyncReadExt, AsyncSeekExt};

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
    let mut file = state.blob_store.open(hash).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound("blob")
        } else {
            AppError::Io(error)
        }
    })?;
    let size = u64::try_from(blob.byte_size).unwrap_or(0);
    match requested_range(headers, size) {
        RangeRequest::Whole => Ok(stream_response(
            file,
            &etag,
            &blob.mime_type,
            blob.byte_size,
        )),
        RangeRequest::Unsatisfiable => {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{size}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            Ok(response)
        }
        RangeRequest::Part { start, end } => {
            file.seek(std::io::SeekFrom::Start(start)).await?;
            let length = end - start + 1;
            let mut response = stream_response(
                file.take(length),
                &etag,
                &blob.mime_type,
                i64::try_from(length).unwrap_or(i64::MAX),
            );
            *response.status_mut() = StatusCode::PARTIAL_CONTENT;
            if let Ok(value) = HeaderValue::from_str(&format!("bytes {start}-{end}/{size}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            Ok(response)
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RangeRequest {
    Whole,
    /// Inclusive byte offsets.
    Part {
        start: u64,
        end: u64,
    },
    Unsatisfiable,
}

/// One `bytes=` range (`a-b`, `a-`, `-suffix`). Anything else — no header,
/// multiple ranges, another unit, malformed — is served whole (RFC 9110
/// lets a server ignore Range).
fn requested_range(headers: &HeaderMap, size: u64) -> RangeRequest {
    let Some(spec) = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().strip_prefix("bytes="))
    else {
        return RangeRequest::Whole;
    };
    if spec.contains(',') {
        return RangeRequest::Whole;
    }
    let Some((first, last)) = spec.trim().split_once('-') else {
        return RangeRequest::Whole;
    };
    let (first, last) = (first.trim(), last.trim());
    let parsed = if first.is_empty() {
        // Suffix: the final N bytes.
        match last.parse::<u64>() {
            Ok(0) => return RangeRequest::Unsatisfiable,
            Ok(suffix) => (size.saturating_sub(suffix), size.saturating_sub(1)),
            Err(_) => return RangeRequest::Whole,
        }
    } else {
        let Ok(start) = first.parse::<u64>() else {
            return RangeRequest::Whole;
        };
        let end = if last.is_empty() {
            size.saturating_sub(1)
        } else {
            match last.parse::<u64>() {
                Ok(end) if end >= start => end.min(size.saturating_sub(1)),
                _ => return RangeRequest::Whole,
            }
        };
        (start, end)
    };
    let (start, end) = parsed;
    if size == 0 || start >= size {
        return RangeRequest::Unsatisfiable;
    }
    RangeRequest::Part { start, end }
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
fn stream_response<R>(file: R, etag: &str, mime_type: &str, byte_size: i64) -> Response
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
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
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn range(value: &str, size: u64) -> RangeRequest {
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, HeaderValue::from_str(value).expect("header"));
        requested_range(&headers, size)
    }

    #[test]
    fn parses_single_byte_ranges() {
        assert_eq!(
            range("bytes=0-99", 1000),
            RangeRequest::Part { start: 0, end: 99 }
        );
        assert_eq!(
            range("bytes=900-", 1000),
            RangeRequest::Part {
                start: 900,
                end: 999
            }
        );
        assert_eq!(
            range("bytes=-100", 1000),
            RangeRequest::Part {
                start: 900,
                end: 999
            }
        );
        assert_eq!(
            range("bytes=990-5000", 1000),
            RangeRequest::Part {
                start: 990,
                end: 999
            }
        );
        assert_eq!(range("bytes=1000-", 1000), RangeRequest::Unsatisfiable);
        assert_eq!(range("bytes=0-1,5-9", 1000), RangeRequest::Whole);
        assert_eq!(range("items=0-1", 1000), RangeRequest::Whole);
        assert_eq!(range("bytes=9-2", 1000), RangeRequest::Whole);
        assert_eq!(
            requested_range(&HeaderMap::new(), 1000),
            RangeRequest::Whole
        );
    }
}
