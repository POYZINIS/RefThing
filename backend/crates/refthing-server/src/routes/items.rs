//! Item routes: single-item CRUD plus the batch scale path. Every mutation
//! funnels through `item_service` — one transaction, one seq bump, one event
//! row per request. Full paths; `TimeoutLayer` + `CompressionLayer` are
//! applied at composition time (`router.rs`).

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{patch, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::Principal;
use crate::dto::Item;
use crate::dto::ops::{BatchRequest, ItemPatch};
use crate::error::{AppError, AppResult};
use crate::services::item_service;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/boards/{id}/items", post(create_item))
        .route("/api/boards/{id}/items/batch", post(batch))
        .route(
            "/api/boards/{id}/items/{item_id}",
            patch(patch_item).delete(delete_item),
        )
}

#[derive(Debug, Deserialize)]
struct CreateItemBody {
    #[serde(rename = "type")]
    item_type: String,
    blob_hash: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct ItemEnvelope {
    seq: i64,
    item: Item,
}

#[derive(Debug, Serialize)]
struct SeqEnvelope {
    seq: i64,
}

/// PATCH body: an [`ItemPatch`] plus an optional `base_seq` (omit to patch
/// against the board's current seq).
#[derive(Debug, Deserialize)]
struct PatchItemBody {
    base_seq: Option<i64>,
    #[serde(flatten)]
    patch: ItemPatch,
}

async fn create_item(
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
    _principal: Principal,
    Json(body): Json<CreateItemBody>,
) -> AppResult<(StatusCode, Json<ItemEnvelope>)> {
    let new = item_service::CreateItem {
        item_type: body.item_type,
        blob_hash: body.blob_hash,
        x: body.x,
        y: body.y,
        width: body.width,
        height: body.height,
        metadata: body.metadata,
    };
    let (seq, item) = item_service::create_item(&state, board_id, new).await?;
    Ok((StatusCode::CREATED, Json(ItemEnvelope { seq, item })))
}

async fn patch_item(
    State(state): State<AppState>,
    Path((board_id, item_id)): Path<(Uuid, Uuid)>,
    _principal: Principal,
    Json(body): Json<PatchItemBody>,
) -> AppResult<Response> {
    if body.patch.is_empty() {
        return Err(AppError::BadRequest("empty patch".to_string()));
    }
    match item_service::patch_item(&state, board_id, item_id, body.base_seq, body.patch).await {
        Ok((seq, item)) => Ok(Json(ItemEnvelope { seq, item }).into_response()),
        Err(AppError::Conflict(message)) => Ok(seq_conflict(&message)),
        Err(error) => Err(error),
    }
}

async fn delete_item(
    State(state): State<AppState>,
    Path((board_id, item_id)): Path<(Uuid, Uuid)>,
    _principal: Principal,
) -> AppResult<Json<SeqEnvelope>> {
    let seq = item_service::delete_item(&state, board_id, item_id).await?;
    Ok(Json(SeqEnvelope { seq }))
}

async fn batch(
    State(state): State<AppState>,
    Path(board_id): Path<Uuid>,
    _principal: Principal,
    Json(request): Json<BatchRequest>,
) -> AppResult<Response> {
    match item_service::apply_batch(&state, board_id, request).await {
        Ok(response) => Ok(Json(response).into_response()),
        Err(AppError::Conflict(message)) => Ok(seq_conflict(&message)),
        Err(error) => Err(error),
    }
}

/// The wire contract for a stale `base_seq` is 409 + code `seq_conflict`,
/// narrower than `AppError::Conflict`'s generic `conflict`, so batch-capable
/// handlers render it themselves.
fn seq_conflict(message: &str) -> Response {
    (
        StatusCode::CONFLICT,
        Json(json!({"error": {"code": "seq_conflict", "message": message}})),
    )
        .into_response()
}
