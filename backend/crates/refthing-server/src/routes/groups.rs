//! Group CRUD, board-scoped. Every mutation rides one write transaction
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
        .route("/api/boards/{id}/groups", post(create_group))
        .route(
            "/api/boards/{id}/groups/{gid}",
            axum::routing::patch(update_group).delete(delete_group),
        )
}

/// Cross-checks a requested parent group: it must exist on the same board and
/// must not be the group itself. Runs outside the mutation transaction —
/// acceptable for a local single-user app, and the FK is the backstop.
async fn validate_parent(
    state: &AppState,
    board_id: Uuid,
    parent_id: Uuid,
    group_id: Option<Uuid>,
) -> AppResult<()> {
    if Some(parent_id) == group_id {
        return Err(AppError::BadRequest(
            "a group cannot be its own parent".to_string(),
        ));
    }
    let parent = refthing_core::db::groups::get(&state.pools.read, parent_id)
        .await?
        .ok_or_else(|| AppError::BadRequest("parent group not found".to_string()))?;
    if parent.board_id != board_id {
        return Err(AppError::BadRequest(
            "parent group belongs to another board".to_string(),
        ));
    }
    Ok(())
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

async fn create_group(
    _principal: Principal,
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
    Json(body): Json<board_service::NewGroup>,
) -> AppResult<Response> {
    if let Some(parent_id) = body.parent_group_id {
        validate_parent(&state, board_id, parent_id, None).await?;
    }

    let mut tx = state.pools.write.begin().await?;
    let Some((seq, _ops, group)) = board_service::create_group(&mut tx, board_id, &body).await?
    else {
        return Err(AppError::NotFound("board"));
    };
    tx.commit().await?;

    broadcast(&state, board_id, seq);
    Ok((
        StatusCode::CREATED,
        Json(json!({"seq": seq, "group": group})),
    )
        .into_response())
}

async fn update_group(
    _principal: Principal,
    State(state): State<AppState>,
    Path((board_id, group_id)): Path<(Uuid, Uuid)>,
    Json(patch): Json<board_service::GroupPatch>,
) -> AppResult<Response> {
    if patch.is_empty() {
        return Err(AppError::BadRequest("empty patch".to_string()));
    }
    if let Some(Some(parent_id)) = patch.parent_group_id {
        validate_parent(&state, board_id, parent_id, Some(group_id)).await?;
    }

    let mut tx = state.pools.write.begin().await?;
    let Some((seq, _ops, group)) =
        board_service::update_group(&mut tx, board_id, group_id, &patch).await?
    else {
        return Err(AppError::NotFound("group"));
    };
    tx.commit().await?;

    broadcast(&state, board_id, seq);
    Ok(Json(json!({"seq": seq, "group": group})).into_response())
}

async fn delete_group(
    _principal: Principal,
    State(state): State<AppState>,
    Path((board_id, group_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Response> {
    let mut tx = state.pools.write.begin().await?;
    let Some((seq, _ops)) = board_service::delete_group(&mut tx, board_id, group_id).await? else {
        return Err(AppError::NotFound("group"));
    };
    tx.commit().await?;

    broadcast(&state, board_id, seq);
    Ok(StatusCode::NO_CONTENT.into_response())
}
