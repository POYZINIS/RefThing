//! Saved-view routes (Phase 6). Views are pure client-side navigation
//! bookmarks stored server-side: no seq bump, no event-log entry, no
//! broadcast.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use axum::{Json, Router};
use uuid::Uuid;

use refthing_server::services::views;

use crate::auth::Principal;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/boards/{id}/views", get(list_views).post(create_view))
        .route(
            "/api/boards/{id}/views/{vid}",
            patch(rename_view).delete(delete_view),
        )
}

async fn list_views(
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
) -> AppResult<Response> {
    let views = views::list(&state.pools.read, board_id).await?;
    Ok(Json(views).into_response())
}

async fn create_view(
    _principal: Principal,
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
    Json(body): Json<views::NewView>,
) -> AppResult<Response> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name must not be empty".to_string()));
    }
    if !body.viewport.is_object() {
        return Err(AppError::BadRequest(
            "viewport must be a JSON object".to_string(),
        ));
    }
    let view = views::create(&state.pools.write, board_id, name, body.viewport).await?;
    Ok((StatusCode::CREATED, Json(view)).into_response())
}

async fn rename_view(
    _principal: Principal,
    State(state): State<AppState>,
    Path((_board_id, view_id)): Path<(Uuid, Uuid)>,
    Json(patch): Json<views::ViewPatch>,
) -> AppResult<Response> {
    if patch.is_empty() {
        return Err(AppError::BadRequest("empty patch".to_string()));
    }
    let Some(name) = patch.name.as_deref() else {
        return Err(AppError::BadRequest("name must be provided".to_string()));
    };
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name must not be empty".to_string()));
    }
    if !views::rename(&state.pools.write, view_id, name).await? {
        return Err(AppError::NotFound("view"));
    }
    let view = views::get(&state.pools.read, view_id).await?;
    Ok(Json(view.ok_or(AppError::NotFound("view"))?).into_response())
}

async fn delete_view(
    _principal: Principal,
    State(state): State<AppState>,
    Path((_board_id, view_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Response> {
    if !views::delete(&state.pools.write, view_id).await? {
        return Err(AppError::NotFound("view"));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
