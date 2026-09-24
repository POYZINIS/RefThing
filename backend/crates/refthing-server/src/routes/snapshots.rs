//! Versioned board snapshots (Phase 7): capture, list, restore.
//!
//! Endpoints allow clients to save and restore board state for rollback.
//! Snapshots are pruned to the most recent N per board automatically.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use refthing_server::services::snapshots;

use crate::auth::Principal;
use crate::error::{AppError, AppResult};
use crate::events::hub::ServerMsg;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/boards/{id}/snapshots",
            post(capture_snapshot).get(list_snapshots),
        )
        .route(
            "/api/boards/{id}/snapshots/{created_at}/restore",
            post(restore_snapshot),
        )
}

async fn capture_snapshot(
    _principal: Principal,
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
    Json(body): Json<CaptureBody>,
) -> AppResult<Response> {
    let snapshot = snapshots::capture(&state.pools.write, board_id, &body.label)
        .await?
        .ok_or(AppError::NotFound("board"))?;
    Ok((StatusCode::CREATED, Json(snapshot)).into_response())
}

#[derive(Debug, Deserialize)]
struct CaptureBody {
    #[serde(default)]
    label: String,
}

async fn list_snapshots(
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
) -> AppResult<Response> {
    if refthing_core::db::boards::get(&state.pools.read, board_id)
        .await?
        .is_none()
    {
        return Err(AppError::NotFound("board"));
    }
    let list = snapshots::list(&state.pools.read, board_id).await?;
    Ok(Json(list).into_response())
}

async fn restore_snapshot(
    _principal: Principal,
    State(state): State<AppState>,
    Path((board_id, created_at)): Path<(Uuid, i64)>,
) -> AppResult<Response> {
    let seq = snapshots::restore(&state.pools.write, board_id, created_at)
        .await?
        .ok_or(AppError::NotFound("snapshot"))?;
    state.hub.broadcast(
        board_id,
        ServerMsg::Diff {
            board_id,
            seq,
            origin: None,
            ops: vec![],
        },
    );
    Ok(Json(serde_json::json!({"status": "restored", "seq": seq})).into_response())
}
