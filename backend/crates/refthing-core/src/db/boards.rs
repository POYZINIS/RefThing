//! Board CRUD.
//!
//! `query_as!` maps columns onto struct fields by alias with per-field
//! `Into` conversions, so `Uuid`/`DateTime<Utc>` columns carry explicit
//! `"name!: Type"` overrides (the `!` because a `TEXT PRIMARY KEY` is still
//! nullable to SQLite).

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::CoreError;
use crate::models::Board;

/// Board row plus its item count, for the board picker.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BoardSummary {
    pub id: Uuid,
    pub name: String,
    pub seq: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub item_count: i64,
}

/// Creates a board with a fresh `UUIDv7` and returns it with server-generated
/// fields (timestamps, `seq`) populated.
pub async fn create(pool: &SqlitePool, name: &str) -> Result<Board, CoreError> {
    let id = Uuid::now_v7();
    sqlx::query_as!(
        Board,
        "INSERT INTO boards (id, name) VALUES (?, ?) RETURNING id AS \"id!: Uuid\", name AS \"name!\", seq AS \"seq!\", created_at AS \"created_at!: DateTime<Utc>\", updated_at AS \"updated_at!: DateTime<Utc>\", viewport_state AS \"viewport_state: serde_json::Value\"",
        id,
        name,
    )
    .fetch_one(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Fetches a board by id; `None` when it does not exist.
pub async fn get(pool: &SqlitePool, id: Uuid) -> Result<Option<Board>, CoreError> {
    sqlx::query_as!(
        Board,
        "SELECT id AS \"id!: Uuid\", name AS \"name!\", seq AS \"seq!\", created_at AS \"created_at!: DateTime<Utc>\", updated_at AS \"updated_at!: DateTime<Utc>\", viewport_state AS \"viewport_state: serde_json::Value\" FROM boards WHERE id = ?",
        id,
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Lists all boards with their item counts, ordered by name.
pub async fn list(pool: &SqlitePool) -> Result<Vec<BoardSummary>, CoreError> {
    sqlx::query_as!(
        BoardSummary,
        "SELECT b.id AS \"id!: Uuid\", b.name AS \"name!\", b.seq AS \"seq!\", \
                b.created_at AS \"created_at!: DateTime<Utc>\", \
                b.updated_at AS \"updated_at!: DateTime<Utc>\", \
                (SELECT COUNT(*) FROM items i WHERE i.board_id = b.id) AS \"item_count!\" \
         FROM boards b ORDER BY b.name COLLATE NOCASE, b.id",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Renames a board. Returns `false` when no board has `id`.
pub async fn rename(pool: &SqlitePool, id: Uuid, name: &str) -> Result<bool, CoreError> {
    let result = sqlx::query!("UPDATE boards SET name = ? WHERE id = ?", name, id)
        .execute(pool)
        .await
        .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Replaces a board's persisted viewport (`{x, y, zoom}` JSON, `None` resets
/// to the default view). Returns `false` when no board has `id`.
pub async fn set_viewport_state(
    pool: &SqlitePool,
    id: Uuid,
    viewport_state: Option<&serde_json::Value>,
) -> Result<bool, CoreError> {
    let viewport_state = viewport_state.cloned();
    let result = sqlx::query!(
        "UPDATE boards SET viewport_state = ? WHERE id = ?",
        viewport_state,
        id,
    )
    .execute(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Deletes a board; its groups, items, notes, and tag links cascade.
/// Referenced blobs survive (see `blobs` for the GC story). Returns `false`
/// when no board has `id`.
pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<bool, CoreError> {
    let result = sqlx::query!("DELETE FROM boards WHERE id = ?", id)
        .execute(pool)
        .await
        .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::db::{Pools, connect, items};

    async fn temp_pools() -> (tempfile::TempDir, Pools) {
        let dir = tempfile::tempdir().expect("temp dir");
        let pools = connect(&dir.path().join("test.db")).await.expect("connect");
        (dir, pools)
    }

    #[tokio::test]
    async fn create_get_round_trip() {
        let (_dir, pools) = temp_pools().await;
        let board = create(&pools.write, "my board").await.expect("create");

        assert_eq!(board.name, "my board");
        assert_eq!(board.seq, 0);
        assert!(board.viewport_state.is_none());

        let fetched = get(&pools.read, board.id)
            .await
            .expect("get")
            .expect("exists");
        assert_eq!(fetched.id, board.id);
        assert_eq!(fetched.name, board.name);
    }

    #[tokio::test]
    async fn get_missing_returns_none() {
        let (_dir, pools) = temp_pools().await;
        assert!(
            get(&pools.read, Uuid::now_v7())
                .await
                .expect("get")
                .is_none()
        );
    }

    #[tokio::test]
    async fn list_reports_item_counts() {
        let (_dir, pools) = temp_pools().await;
        let alpha = create(&pools.write, "alpha").await.expect("create alpha");
        create(&pools.write, "beta").await.expect("create beta");

        for z_index in 0..3 {
            items::create(
                &pools.write,
                items::NewItem {
                    board_id: alpha.id,
                    item_type: "image".to_string(),
                    blob_id: None,
                    x: 0.0,
                    y: 0.0,
                    width: 10.0,
                    height: 10.0,
                    rotation: 0.0,
                    z_index,
                    group_id: None,
                },
            )
            .await
            .expect("create item");
        }

        let summaries = list(&pools.read).await.expect("list");
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].name, "alpha");
        assert_eq!(summaries[0].item_count, 3);
        assert_eq!(summaries[1].name, "beta");
        assert_eq!(summaries[1].item_count, 0);
    }

    #[tokio::test]
    async fn rename_and_viewport_update() {
        let (_dir, pools) = temp_pools().await;
        let board = create(&pools.write, "old").await.expect("create");

        assert!(rename(&pools.write, board.id, "new").await.expect("rename"));
        assert!(
            !rename(&pools.write, Uuid::now_v7(), "nope")
                .await
                .expect("rename missing")
        );

        let viewport = json!({"x": 10.0, "y": -4.0, "zoom": 1.5});
        assert!(
            set_viewport_state(&pools.write, board.id, Some(&viewport))
                .await
                .expect("set viewport")
        );
        let fetched = get(&pools.read, board.id)
            .await
            .expect("get")
            .expect("exists");
        assert_eq!(fetched.name, "new");
        assert_eq!(fetched.viewport_state, Some(viewport));
        assert!(fetched.updated_at >= board.updated_at);

        assert!(
            set_viewport_state(&pools.write, board.id, None)
                .await
                .expect("clear viewport")
        );
        let fetched = get(&pools.read, board.id)
            .await
            .expect("get")
            .expect("exists");
        assert!(fetched.viewport_state.is_none());
    }

    #[tokio::test]
    async fn delete_cascades_items() {
        let (_dir, pools) = temp_pools().await;
        let board = create(&pools.write, "doomed").await.expect("create");
        let item = items::create(
            &pools.write,
            items::NewItem {
                board_id: board.id,
                item_type: "image".to_string(),
                blob_id: None,
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
                rotation: 0.0,
                z_index: 0,
                group_id: None,
            },
        )
        .await
        .expect("create item");

        assert!(delete(&pools.write, board.id).await.expect("delete"));
        assert!(!delete(&pools.write, board.id).await.expect("delete again"));
        assert!(get(&pools.read, board.id).await.expect("get").is_none());
        assert!(
            items::get(&pools.read, item.id)
                .await
                .expect("get item")
                .is_none()
        );
    }
}
