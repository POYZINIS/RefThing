//! Full-text search route (Phase 6 FTS5). Board-scoped; returns ranked items.

use axum::extract::{Path, Query, State};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use uuid::Uuid;

use refthing_server::services::search;

use crate::error::AppResult;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/boards/{id}/search", get(search_board))
        .route("/api/boards/{id}/search-colour", get(search_colour))
        .route("/api/boards/{id}/duplicates", get(search_duplicates))
}

async fn search_board(
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
    Query(params): Query<SearchQuery>,
) -> AppResult<Response> {
    let results = search::search(&state.pools.read, board_id, &params.q).await?;
    Ok(Json(results).into_response())
}

async fn search_colour(
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
    Query(params): Query<ColourQuery>,
) -> AppResult<Response> {
    let results = search::search_by_colour(&state.pools.read, board_id, &params.colour).await?;
    Ok(Json(results).into_response())
}

async fn search_duplicates(
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
) -> AppResult<Response> {
    let results = search::find_duplicates(&state.pools.read, board_id).await?;
    Ok(Json(results).into_response())
}

#[derive(Debug, serde::Deserialize)]
struct SearchQuery {
    q: String,
}

#[derive(Debug, serde::Deserialize)]
struct ColourQuery {
    colour: String,
}
