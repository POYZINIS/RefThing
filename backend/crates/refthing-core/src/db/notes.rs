//! Note CRUD. `content_json` is the rich-text payload (JSON, enforced by a
//! `json_valid` CHECK).
//!
//! See `items.rs` for why the column aliases carry `"name!: Type"`
//! overrides.

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::CoreError;
use crate::models::Note;

/// Creates a note with a fresh `UUIDv7` and returns it fully populated.
pub async fn create(
    pool: &SqlitePool,
    board_id: Uuid,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    content_json: serde_json::Value,
) -> Result<Note, CoreError> {
    let id = Uuid::now_v7();
    sqlx::query_as!(
        Note,
        "INSERT INTO notes (id, board_id, x, y, width, height, rotation, z_index, content_json) \
             VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?) RETURNING id AS \"id!: Uuid\", board_id AS \"board_id: Uuid\", x, y, width, height, rotation, z_index, content_json AS \"content_json: serde_json::Value\", bg_color, opacity AS \"opacity!\", created_at AS \"created_at: DateTime<Utc>\", updated_at AS \"updated_at: DateTime<Utc>\"",
        id,
        board_id,
        x,
        y,
        width,
        height,
        content_json,
    )
    .fetch_one(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Fetches a note by id; `None` when it does not exist.
pub async fn get(pool: &SqlitePool, id: Uuid) -> Result<Option<Note>, CoreError> {
    sqlx::query_as!(
        Note,
        "SELECT id AS \"id!: Uuid\", board_id AS \"board_id: Uuid\", x, y, width, height, rotation, z_index, content_json AS \"content_json: serde_json::Value\", bg_color, opacity AS \"opacity!\", created_at AS \"created_at: DateTime<Utc>\", updated_at AS \"updated_at: DateTime<Utc>\" FROM notes WHERE id = ?",
        id,
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Lists a board's notes, ordered by creation time.
pub async fn list_by_board(
    executor: impl sqlx::SqliteExecutor<'_>,
    board_id: Uuid,
) -> Result<Vec<Note>, CoreError> {
    sqlx::query_as!(
        Note,
        "SELECT id AS \"id!: Uuid\", board_id AS \"board_id: Uuid\", x, y, width, height, rotation, z_index, content_json AS \"content_json: serde_json::Value\", bg_color, opacity AS \"opacity!\", created_at AS \"created_at: DateTime<Utc>\", updated_at AS \"updated_at: DateTime<Utc>\" FROM notes WHERE board_id = ? ORDER BY z_index ASC, id",
        board_id,
    )
    .fetch_all(executor)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Replaces a note's geometry. Returns `false` when no note has `id`.
#[allow(clippy::too_many_arguments)]
pub async fn update_geometry(
    pool: &SqlitePool,
    id: Uuid,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    z_index: i64,
) -> Result<bool, CoreError> {
    let result = sqlx::query!(
        "UPDATE notes SET x = ?, y = ?, width = ?, height = ?, rotation = ?, z_index = ? WHERE id = ?",
        x,
        y,
        width,
        height,
        rotation,
        z_index,
        id,
    )
    .execute(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Replaces a note's rich-text content. Returns `false` when no note has
/// `id`.
pub async fn update_content(
    pool: &SqlitePool,
    id: Uuid,
    content_json: &serde_json::Value,
) -> Result<bool, CoreError> {
    let content_json = content_json.clone();
    let result = sqlx::query!(
        "UPDATE notes SET content_json = ? WHERE id = ?",
        content_json,
        id,
    )
    .execute(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Deletes a note. Returns `false` when no note has `id`.
pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<bool, CoreError> {
    let result = sqlx::query!("DELETE FROM notes WHERE id = ?", id)
        .execute(pool)
        .await
        .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::db::{Pools, boards, connect};

    fn assert_f64_eq(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "expected {expected}, got {actual}"
        );
    }
    async fn temp_pools_with_board() -> (tempfile::TempDir, Pools, Uuid) {
        let dir = tempfile::tempdir().expect("temp dir");
        let pools = connect(&dir.path().join("test.db")).await.expect("connect");
        let board = boards::create(&pools.write, "board")
            .await
            .expect("create board");
        (dir, pools, board.id)
    }

    #[tokio::test]
    async fn create_get_round_trip() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        let content = json!({"type": "doc", "content": []});
        let note = create(
            &pools.write,
            board_id,
            1.0,
            2.0,
            300.0,
            200.0,
            content.clone(),
        )
        .await
        .expect("create");

        assert_eq!(note.content_json, content);
        assert_f64_eq(note.opacity, 1.0);
        assert!(note.bg_color.is_none());

        let fetched = get(&pools.read, note.id)
            .await
            .expect("get")
            .expect("exists");
        assert_eq!(fetched.id, note.id);
        assert_f64_eq(fetched.width, 300.0);
    }

    #[tokio::test]
    async fn list_by_board_scopes_to_board() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        let other = boards::create(&pools.write, "other")
            .await
            .expect("create other");
        create(&pools.write, board_id, 0.0, 0.0, 10.0, 10.0, json!({}))
            .await
            .expect("create note");
        create(&pools.write, other.id, 0.0, 0.0, 10.0, 10.0, json!({}))
            .await
            .expect("create other note");

        let notes = list_by_board(&pools.read, board_id).await.expect("list");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].board_id, board_id);
    }

    #[tokio::test]
    async fn update_geometry_and_content() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        let note = create(&pools.write, board_id, 0.0, 0.0, 10.0, 10.0, json!({}))
            .await
            .expect("create");

        assert!(
            update_geometry(&pools.write, note.id, 5.0, 6.0, 20.0, 30.0, 45.0, 7)
                .await
                .expect("update geometry")
        );
        let new_content = json!({"type": "doc", "content": [{"type": "paragraph"}]});
        assert!(
            update_content(&pools.write, note.id, &new_content)
                .await
                .expect("update content")
        );
        assert!(
            !update_geometry(&pools.write, Uuid::now_v7(), 0.0, 0.0, 1.0, 1.0, 0.0, 0)
                .await
                .expect("update missing")
        );

        let fetched = get(&pools.read, note.id)
            .await
            .expect("get")
            .expect("exists");
        assert_f64_eq(fetched.x, 5.0);
        assert_f64_eq(fetched.height, 30.0);
        assert_f64_eq(fetched.rotation, 45.0);
        assert_eq!(fetched.z_index, 7);
        assert_eq!(fetched.content_json, new_content);
        assert!(fetched.updated_at >= note.updated_at);
    }

    #[tokio::test]
    async fn delete_removes_note() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        let note = create(&pools.write, board_id, 0.0, 0.0, 10.0, 10.0, json!({}))
            .await
            .expect("create");

        assert!(delete(&pools.write, note.id).await.expect("delete"));
        assert!(!delete(&pools.write, note.id).await.expect("delete again"));
        assert!(get(&pools.read, note.id).await.expect("get").is_none());
    }
}
