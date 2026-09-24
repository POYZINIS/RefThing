//! Saved board views (named viewport bookmarks), Phase 6.
//!
//! A view captures the board's `viewport_state` JSON `{x, y, zoom}` under a
//! human name. Views are board-scoped and purely navigational: applying them
//! reuses the same wire shape as the board's own `viewport_state`, so the
//! client does not need a different rendering path.

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::CoreError;
use crate::models::BoardView;

/// Creates a view under `board_id` with `name` and `viewport`, returning it
/// fully populated.
pub async fn create(
    pool: &SqlitePool,
    board_id: Uuid,
    name: &str,
    viewport: serde_json::Value,
) -> Result<BoardView, CoreError> {
    let id = Uuid::now_v7();
    sqlx::query_as!(
        BoardView,
        "INSERT INTO board_views (id, board_id, name, viewport) \
             VALUES (?, ?, ?, ?) RETURNING id AS \"id!: Uuid\", board_id AS \"board_id: Uuid\", name, viewport AS \"viewport: serde_json::Value\", created_at AS \"created_at: DateTime<Utc>\", updated_at AS \"updated_at: DateTime<Utc>\"",
        id,
        board_id,
        name,
        viewport,
    )
    .fetch_one(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Lists a board's views, oldest first.
pub async fn list_by_board(pool: &SqlitePool, board_id: Uuid) -> Result<Vec<BoardView>, CoreError> {
    sqlx::query_as!(
        BoardView,
        "SELECT id AS \"id!: Uuid\", board_id AS \"board_id: Uuid\", name, viewport AS \"viewport: serde_json::Value\", created_at AS \"created_at: DateTime<Utc>\", updated_at AS \"updated_at: DateTime<Utc>\" FROM board_views WHERE board_id = ? ORDER BY created_at, id",
        board_id,
    )
    .fetch_all(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Fetches a single view; `None` when it does not exist.
pub async fn get(pool: &SqlitePool, id: Uuid) -> Result<Option<BoardView>, CoreError> {
    sqlx::query_as!(
        BoardView,
        "SELECT id AS \"id!: Uuid\", board_id AS \"board_id: Uuid\", name, viewport AS \"viewport: serde_json::Value\", created_at AS \"created_at: DateTime<Utc>\", updated_at AS \"updated_at: DateTime<Utc>\" FROM board_views WHERE id = ?",
        id,
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Renames a view. Returns `false` when no view has `id`.
pub async fn rename(pool: &SqlitePool, id: Uuid, name: &str) -> Result<bool, CoreError> {
    let result = sqlx::query!(
        "UPDATE board_views SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
        name,
        id,
    )
    .execute(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Deletes a view. Returns `false` when no view has `id`.
pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<bool, CoreError> {
    let result = sqlx::query!("DELETE FROM board_views WHERE id = ?", id)
        .execute(pool)
        .await
        .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}
