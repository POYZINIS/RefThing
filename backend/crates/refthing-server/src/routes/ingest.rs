//! Multipart ingest route. Composition contract (`routes/mod.rs`,
//! `router.rs`): 1 GiB `DefaultBodyLimit` and NO `TimeoutLayer` — slow
//! uploads must not be killed.
//!
//! The `items:ingest` segment is a full literal (matchit 0.8 only treats
//! `{...}` as parameters, and `:` carries no special meaning mid-segment in
//! axum 0.8), so this coexists with `/api/boards/{id}/items/{item_id}`.
//!
//! Covered by `tests/api_items_ingest.rs` — every test there builds this
//! router, so a matchit rejection of the literal would panic at router build.

use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use axum::routing::post;
use axum::{Json, Router};
use uuid::Uuid;

use crate::auth::Principal;
use crate::error::AppResult;
use crate::services::ingest_service;
use crate::services::ingest_service::IngestResponse;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/boards/{id}/items:ingest", post(ingest))
}

async fn ingest(
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
    _principal: Principal,
    multipart: Multipart,
) -> AppResult<(StatusCode, Json<IngestResponse>)> {
    let response = ingest_service::ingest(&state, board_id, multipart).await?;
    Ok((StatusCode::ACCEPTED, Json(response)))
}
