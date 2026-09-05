//! Blob byte serving: `GET /blob/{hash}/{level}`.
//!
//! Phase 2 serves only `full` — the original bytes streamed from the
//! content-addressed store (never buffered whole) with immutable caching and a
//! strong `ETag`. The derivative levels (`thumb`/`small`/`medium`) come from the
//! Phase 3 pyramid job; until then they answer `404` + `X-Derivative: pending`
//! so the frontend falls back to `full` without probing.
//!
//! No compression layer touches these bytes (see `router.rs`): media is
//! already compressed.

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Router, routing::get};
use futures_util::stream;
use refthing_core::db::blobs;
use tokio::io::AsyncReadExt;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Immutable forever: the URL is content-addressed, so bytes never change.
const FULL_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";
const READ_CHUNK: usize = 64 * 1024;

pub fn router() -> Router<AppState> {
    Router::new().route("/blob/{hash}/{level}", get(get_blob))
}

async fn get_blob(
    State(state): State<AppState>,
    Path((hash, level)): Path<(String, String)>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let blob = blobs::get(&state.pools.read, &hash)
        .await?
        .ok_or(AppError::NotFound("blob"))?;

    if level != "full" {
        return Ok(derivative_pending(&level));
    }

    let etag = format!("\"{hash}-full\"");
    if if_none_match_matches(&headers, &etag) {
        return Ok(not_modified(&etag));
    }

    let file = state.blob_store.open(&hash).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            AppError::NotFound("blob")
        } else {
            AppError::Io(error)
        }
    })?;

    Ok(full_response(file, &etag, &blob.mime_type, blob.byte_size))
}

/// Streams the blob in [`READ_CHUNK`] pieces; the file handle travels with the
/// stream so the whole file is never resident in memory.
fn full_response(file: tokio::fs::File, etag: &str, mime_type: &str, byte_size: i64) -> Response {
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

/// Derivative levels are Phase 3: 404 with `X-Derivative: pending` tells the
/// frontend to fall back to `full`. Unrecognized levels get a plain 404.
fn derivative_pending(level: &str) -> Response {
    if matches!(level, "thumb" | "small" | "medium") {
        let mut response = AppError::NotFound("derivative (pyramid job pending)").into_response();
        response.headers_mut().insert(
            header::HeaderName::from_static("x-derivative"),
            HeaderValue::from_static("pending"),
        );
        response
    } else {
        AppError::NotFound("blob level").into_response()
    }
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
