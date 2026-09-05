//! Global tag CRUD. Tags are not board-scoped: no `seq` bump, no event-log
//! entry, no broadcast — tag assignment to items rides item patches.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch};
use axum::{Json, Router};
use uuid::Uuid;

use refthing_server::services::tag_service;

use crate::auth::Principal;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tags", get(list_tags).post(create_tag))
        .route("/api/tags/{id}", patch(update_tag).delete(delete_tag))
}

/// Maps a duplicate-name violation to 409; anything else propagates.
fn unique_to_conflict(error: sqlx::Error) -> AppError {
    if tag_service::is_unique_violation(&error) {
        AppError::Conflict("a tag with that name already exists".to_string())
    } else {
        AppError::Db(error)
    }
}

async fn list_tags(State(state): State<AppState>) -> AppResult<Response> {
    let tags = tag_service::list(&state.pools.read).await?;
    Ok(Json(tags).into_response())
}

async fn create_tag(
    _principal: Principal,
    State(state): State<AppState>,
    Json(body): Json<tag_service::NewTag>,
) -> AppResult<Response> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("name must not be empty".to_string()));
    }
    let tag = tag_service::create(&state.pools.write, name, body.color.as_deref())
        .await
        .map_err(unique_to_conflict)?;
    Ok((StatusCode::CREATED, Json(tag)).into_response())
}

async fn update_tag(
    _principal: Principal,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(patch): Json<tag_service::TagPatch>,
) -> AppResult<Response> {
    if patch.is_empty() {
        return Err(AppError::BadRequest("empty patch".to_string()));
    }
    if let Some(name) = patch.name.as_deref()
        && name.trim().is_empty()
    {
        return Err(AppError::BadRequest("name must not be empty".to_string()));
    }
    let Some(tag) = tag_service::update(&state.pools.write, id, &patch)
        .await
        .map_err(unique_to_conflict)?
    else {
        return Err(AppError::NotFound("tag"));
    };
    Ok(Json(tag).into_response())
}

async fn delete_tag(
    _principal: Principal,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<Response> {
    if !tag_service::delete(&state.pools.write, id).await? {
        return Err(AppError::NotFound("tag"));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
