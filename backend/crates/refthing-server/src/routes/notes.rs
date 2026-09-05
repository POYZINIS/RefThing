//! Note CRUD, board-scoped. Every mutation rides one write transaction
//! (mutate → `append_event` → commit) and then broadcasts a
//! [`ServerMsg::Diff`]; see `boards.rs` for why the diff's `ops` is empty.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::json;
use uuid::Uuid;

use refthing_server::services::board_service;

use crate::auth::Principal;
use crate::error::{AppError, AppResult};
use crate::events::hub::ServerMsg;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/boards/{id}/notes", post(create_note))
        .route(
            "/api/boards/{id}/notes/{nid}",
            axum::routing::patch(update_note).delete(delete_note),
        )
}

fn broadcast(state: &AppState, board_id: Uuid, seq: i64) {
    state.hub.broadcast(
        board_id,
        ServerMsg::Diff {
            board_id,
            seq,
            origin: None,
            ops: vec![],
        },
    );
}

async fn create_note(
    _principal: Principal,
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
    Json(body): Json<board_service::NewNote>,
) -> AppResult<Response> {
    let mut tx = state.pools.write.begin().await?;
    let Some((seq, _ops, note)) = board_service::create_note(&mut tx, board_id, &body).await?
    else {
        return Err(AppError::NotFound("board"));
    };
    tx.commit().await?;

    broadcast(&state, board_id, seq);
    Ok((StatusCode::CREATED, Json(json!({"seq": seq, "note": note}))).into_response())
}

async fn update_note(
    _principal: Principal,
    State(state): State<AppState>,
    Path((board_id, note_id)): Path<(Uuid, Uuid)>,
    Json(patch): Json<board_service::NotePatch>,
) -> AppResult<Response> {
    if patch.is_empty() {
        return Err(AppError::BadRequest("empty patch".to_string()));
    }

    let mut tx = state.pools.write.begin().await?;
    let Some((seq, _ops, note)) =
        board_service::update_note(&mut tx, board_id, note_id, &patch).await?
    else {
        return Err(AppError::NotFound("note"));
    };
    tx.commit().await?;

    broadcast(&state, board_id, seq);
    Ok(Json(json!({"seq": seq, "note": note})).into_response())
}

async fn delete_note(
    _principal: Principal,
    State(state): State<AppState>,
    Path((board_id, note_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Response> {
    let mut tx = state.pools.write.begin().await?;
    let Some((seq, _ops)) = board_service::delete_note(&mut tx, board_id, note_id).await? else {
        return Err(AppError::NotFound("note"));
    };
    tx.commit().await?;

    broadcast(&state, board_id, seq);
    Ok(StatusCode::NO_CONTENT.into_response())
}
