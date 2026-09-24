//! Saved-view business logic (Phase 6). Views are board-scoped bookmarks over
//! the live viewport: no seq bump, no event-log entry, no broadcast — they
//! are purely client-side navigation conveniences stored server-side.

use refthing_core::db;
use refthing_core::error::CoreError;
use serde::Deserialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::dto;

/// Request body for creating a view. `viewport` is the `{x, y, zoom}` shape
/// the board's own `viewport_state` uses; an absent/malformed value defaults
/// to the identity viewport.
#[derive(Debug, Clone, Deserialize)]
pub struct NewView {
    pub name: String,
    #[serde(default = "default_viewport")]
    pub viewport: serde_json::Value,
}

fn default_viewport() -> serde_json::Value {
    serde_json::json!({ "x": 0, "y": 0, "zoom": 1 })
}

/// Body for renaming a view.
#[derive(Debug, Clone, Deserialize)]
pub struct ViewPatch {
    pub name: Option<String>,
}

impl ViewPatch {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.name.is_none()
    }
}

#[must_use]
pub fn view_dto(view: refthing_core::models::BoardView) -> dto::BoardView {
    dto::BoardView {
        id: view.id,
        board_id: view.board_id,
        name: view.name,
        viewport: view.viewport,
        created_at: super::ms(view.created_at),
        updated_at: super::ms(view.updated_at),
    }
}

/// Lists a board's saved views.
pub async fn list(pool: &SqlitePool, board_id: Uuid) -> Result<Vec<dto::BoardView>, CoreError> {
    let views = db::views::list_by_board(pool, board_id).await?;
    Ok(views.into_iter().map(view_dto).collect())
}

/// Creates a view; the name must be non-empty.
pub async fn create(
    pool: &SqlitePool,
    board_id: Uuid,
    name: &str,
    viewport: serde_json::Value,
) -> Result<dto::BoardView, CoreError> {
    let view = db::views::create(pool, board_id, name, viewport).await?;
    Ok(view_dto(view))
}

/// Fetches one view; `None` when it does not exist.
pub async fn get(pool: &SqlitePool, id: Uuid) -> Result<Option<dto::BoardView>, CoreError> {
    Ok(db::views::get(pool, id).await?.map(view_dto))
}

/// Renames a view. Returns `false` when no view has `id`.
pub async fn rename(pool: &SqlitePool, id: Uuid, name: &str) -> Result<bool, CoreError> {
    db::views::rename(pool, id, name).await
}

/// Deletes a view. Returns `false` when no view has `id`.
pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<bool, CoreError> {
    db::views::delete(pool, id).await
}
