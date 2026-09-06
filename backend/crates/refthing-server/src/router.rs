//! Router composition with the middleware discipline from the Phase 2 design:
//! CORS outermost, then tracing; `TimeoutLayer` + `CompressionLayer` ONLY on
//! the JSON API router — never on WS (kills connections), ingest (kills slow
//! uploads), or blob routes (wasted CPU on pre-compressed bytes).

use std::time::Duration;

use axum::extract::DefaultBodyLimit;
use axum::http::StatusCode;
use axum::{Router, routing::get};
use tower_http::compression::CompressionLayer;
use tower_http::cors::CorsLayer;
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
        .layer(CompressionLayer::new())
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            API_TIMEOUT,
        ));

    // Multipart ingest: raised body limit, no timeout (slow uploads must not
    // be killed).
    let ingest = routes::ingest::router().layer(DefaultBodyLimit::max(INGEST_BODY_LIMIT));

    // WebSocket: no timeout, no compression.
    let realtime = routes::ws::router();

    // Blob bytes: no compression (already-compressed media).
    let blobs = routes::blobs::router();

    Router::new()
        .merge(json_api)
        .merge(ingest)
        .merge(realtime)
        .merge(blobs)
        .with_state(state)
        // Layers added last run first: CORS is outermost, then tracing.
        // To add auth later, insert one `.layer(auth_layer)` here.
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
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
    Ok(axum::Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "pending_jobs": pending_jobs,
        "failed_jobs": failed_jobs,
    })))
}
