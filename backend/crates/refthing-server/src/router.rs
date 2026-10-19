//! Router composition with the middleware discipline from the Phase 2 design:
//! tracing outermost, then the local-only guard (`local_only.rs`, no CORS); `TimeoutLayer` + `CompressionLayer` ONLY on
//! the JSON API router — never on WS (kills connections), ingest (kills slow
//! uploads), or blob routes (wasted CPU on pre-compressed bytes).

use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::http::StatusCode;
use axum::{Router, routing::get};
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::routes;
use crate::state::AppState;

const API_TIMEOUT: Duration = Duration::from_secs(30);
const INGEST_BODY_LIMIT: usize = 1024 * 1024 * 1024; // 1 GiB

pub fn build_router(state: AppState) -> Router {
    // JSON API: health + CRUD sub-routers. The only group that gets
    // compression and a request timeout.
    let json_api = Router::new()
        .route("/api/health", get(health))
        .merge(routes::auth::router())
        .merge(routes::boards::router())
        .merge(routes::items::router())
        .merge(routes::groups::router())
        .merge(routes::notes::router())
        .merge(routes::tags::router())
        .merge(routes::views::router())
        .merge(routes::search::router())
        .merge(routes::snapshots::router())
        .merge(routes::settings::router())
        .layer(CompressionLayer::new())
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            API_TIMEOUT,
        ));

    // Multipart ingest: raised body limit, no timeout (slow uploads must not
    // be killed).
    let ingest = routes::ingest::router().layer(DefaultBodyLimit::max(INGEST_BODY_LIMIT));

    // `.ref` board files: no timeout (writing a big board takes a while),
    // no compression (the file is encrypted — nothing to squeeze).
    let board_files = routes::board_files::router();

    // WebSocket: no timeout, no compression.
    let realtime = routes::ws::router();

    // Blob bytes: no compression (already-compressed media).
    let blobs = routes::blobs::router();

    // Optional SPA fallback: serve the built frontend for any path the API
    // routes don't claim. Used by the desktop app, which points the webview
    // at this server directly.
    let static_dir = state.config.static_dir.clone();

    // Every request — API, WebSocket, blobs, the app's own page files —
    // passes the local-only guard (local_only.rs: no other site, no DNS
    // rebinding). No CORS headers: the app's pages are same-origin.
    let guard_state = state.clone();
    let mut app = Router::new()
        .merge(json_api)
        .merge(ingest)
        .merge(board_files)
        .merge(realtime)
        .merge(blobs)
        .with_state(state);
    if let Some(static_dir) = static_dir {
        let index = static_dir.join("index.html");
        app = app.fallback_service(ServeDir::new(static_dir).fallback(ServeFile::new(index)));
    }
    // Layers added last run first: tracing is outermost (it sees refusals
    // too), then the guard.
    app.layer(axum::middleware::from_fn_with_state(
        guard_state,
        crate::local_only::guard,
    ))
    .layer(TraceLayer::new_for_http())
}

async fn health(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> crate::error::AppResult<axum::Json<serde_json::Value>> {
    let (pending_jobs,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM jobs WHERE status = 'pending'")
            .fetch_one(&state.pools.read)
            .await?;
    let (failed_jobs,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM jobs WHERE status = 'failed'")
            .fetch_one(&state.pools.read)
            .await?;

    // Blob integrity check: sample up to 16 random blobs and verify each
    // on-disk file's SHA-256 matches the stored hash. Full scan is too slow
    // for a health endpoint; 16 gives reasonable coverage with <50ms latency.
    let total_blobs: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM blobs")
        .fetch_one(&state.pools.read)
        .await?;
    let sampled: Vec<(String,)> =
        sqlx::query_as("SELECT hash FROM blobs ORDER BY RANDOM() LIMIT 16")
            .fetch_all(&state.pools.read)
            .await?;

    let mut verified = 0u64;
    let mut corrupted = 0u64;
    let mut missing = 0u64;
    for (hash,) in &sampled {
        use sha2::{Digest, Sha256};
        match tokio::fs::read(state.blob_store.path(hash)).await {
            Ok(bytes) => {
                let actual = format!("{:x}", Sha256::digest(&bytes));
                if &actual == hash {
                    verified += 1;
                } else {
                    corrupted += 1;
                }
            }
            Err(_) => missing += 1,
        }
    }

    Ok(axum::Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "pending_jobs": pending_jobs,
        "failed_jobs": failed_jobs,
        "blob_integrity": {
            "total_blobs": total_blobs.0,
            "sampled": sampled.len(),
            "verified": verified,
            "corrupted": corrupted,
            "missing": missing,
        },
    })))
}
