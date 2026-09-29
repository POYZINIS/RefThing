//! Board CRUD, snapshot hydration, and the `/changes` gap-recovery feed.
//!
//! Handlers stay thin: extract → validate input shape → delegate to
//! `services::board_service` (reached through the lib crate name because the
//! frozen `main.rs` declares no `services` module for the bin target) →
//! commit → broadcast a [`ServerMsg::Diff`]. Board/group/note mutations have
//! no item-centric `BatchOp` shape, so the diff carries `ops: vec![]`; clients
//! reconcile from the event log via `/changes?since=`.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use refthing_server::services::{self, board_service};

use crate::auth::Principal;
use crate::error::{AppError, AppResult};
use crate::events::{self, hub::ServerMsg};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/boards", post(create_board).get(list_boards))
        .route(
            "/api/boards/{id}",
            get(get_board).patch(update_board).delete(delete_board),
        )
        .route("/api/boards/{id}/changes", get(get_changes))
}

async fn create_board(
    _principal: Principal,
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<board_service::NewBoard>,
) -> AppResult<Response> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name must not be empty".to_string()));
    }
    // A folder is a path on this machine: only the app's own pages name one.
    if body.file_folder.is_some() {
        crate::routes::board_files::own_origin(&headers)?;
    }
    let board = refthing_core::db::boards::create(&state.pools.write, name).await?;
    if let Some(folder) = &body.file_folder {
        services::ref_files::link_in_folder(
            &state.pools,
            &state.config.data_dir,
            board.id,
            std::path::Path::new(folder.trim()),
        )
        .await?;
    }
    Ok((StatusCode::CREATED, Json(services::board_dto(board))).into_response())
}

async fn list_boards(State(state): State<AppState>) -> AppResult<Response> {
    let summaries = board_service::list_boards(&state.pools.read).await?;
    Ok(Json(summaries).into_response())
}

async fn get_board(State(state): State<AppState>, Path(id): Path<Uuid>) -> AppResult<Response> {
    let Some(snapshot) = board_service::snapshot(&state.pools.read, id).await? else {
        return Err(AppError::NotFound("board"));
    };
    Ok(Json(snapshot).into_response())
}

async fn update_board(
    _principal: Principal,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(patch): Json<board_service::BoardPatch>,
) -> AppResult<Response> {
    if patch.is_empty() {
        return Err(AppError::BadRequest("empty patch".to_string()));
    }
    if let Some(name) = patch.name.as_deref()
        && name.trim().is_empty()
    {
        return Err(AppError::BadRequest("name must not be empty".to_string()));
    }

    let mut tx = state.pools.write.begin().await?;
    let Some((seq, _ops, board)) = board_service::update_board(&mut tx, id, &patch).await? else {
        return Err(AppError::NotFound("board"));
    };
    tx.commit().await?;

    state.hub.broadcast(
        id,
        ServerMsg::Diff {
            board_id: id,
            seq,
            origin: patch.origin().map(str::to_string),
            ops: vec![],
        },
    );
    Ok(Json(json!({"seq": seq, "board": board})).into_response())
}

async fn delete_board(
    _principal: Principal,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    // No event-log entry: `board_events` cascade-deletes with the board, so a
    // tombstone could not be replayed anyway.
    if !refthing_core::db::boards::delete(&state.pools.write, id).await? {
        return Err(AppError::NotFound("board"));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Debug, Deserialize)]
struct ChangesQuery {
    #[serde(default)]
    since: i64,
}

async fn get_changes(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(query): Query<ChangesQuery>,
) -> AppResult<Response> {
    let Some(board) = refthing_core::db::boards::get(&state.pools.read, id).await? else {
        return Err(AppError::NotFound("board"));
    };
    let events = events::replay_since(&state.pools.read, id, query.since).await?;
    Ok(Json(json!({"seq": board.seq, "events": events})).into_response())
}
