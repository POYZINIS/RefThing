//! Item CRUD, including the paint-order (`z_index`) list query and per-type
//! `item_metadata` payloads.
//!
//! `query_as!` maps columns onto struct fields by alias with per-field
//! `Into` conversions, so `Uuid`/`DateTime<Utc>` columns carry explicit
//! `"name!: Type"` overrides (the `!` because a `TEXT PRIMARY KEY` is still
//! nullable to SQLite).

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::CoreError;
use crate::models::{Item, ItemMetadata};

/// Fields required to place a new item on a board. IDs and timestamps are
/// server-generated.
#[derive(Debug, Clone)]
pub struct NewItem {
    pub board_id: Uuid,
    /// Plain string, not an enum: Phase 11 item types land without a schema
    /// or code change (see `docs/data-model.md`).
    pub item_type: String,
    pub blob_id: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub z_index: i64,
    pub group_id: Option<Uuid>,
}

/// Mutable transform fields of an item; `updated_at` is bumped by trigger.
#[derive(Debug, Clone, Copy)]
pub struct ItemTransform {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub z_index: i64,
}

/// Creates an item with a fresh `UUIDv7` and returns it fully populated.
pub async fn create(pool: &SqlitePool, item: NewItem) -> Result<Item, CoreError> {
    let id = Uuid::now_v7();
    sqlx::query_as!(
        Item,
        "INSERT INTO items \
                 (id, board_id, type, blob_id, x, y, width, height, rotation, z_index, group_id) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id AS \"id!: Uuid\", board_id AS \"board_id: Uuid\", type AS \"item_type!\", blob_id, x, y, width, height, rotation, z_index, group_id AS \"group_id: Uuid\", created_at AS \"created_at: DateTime<Utc>\", updated_at AS \"updated_at: DateTime<Utc>\"",
        id,
        item.board_id,
        item.item_type,
        item.blob_id,
        item.x,
        item.y,
        item.width,
        item.height,
        item.rotation,
        item.z_index,
        item.group_id,
    )
    .fetch_one(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Fetches an item by id; `None` when it does not exist.
pub async fn get(pool: &SqlitePool, id: Uuid) -> Result<Option<Item>, CoreError> {
    sqlx::query_as!(
        Item,
        "SELECT id AS \"id!: Uuid\", board_id AS \"board_id: Uuid\", type AS \"item_type!\", blob_id, x, y, width, height, rotation, z_index, group_id AS \"group_id: Uuid\", created_at AS \"created_at: DateTime<Utc>\", updated_at AS \"updated_at: DateTime<Utc>\" FROM items WHERE id = ?",
        id,
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Lists a board's items in paint order (ascending `z_index`, ties broken by
/// id). This is the hot board-load query and rides `idx_items_board_paint`.
pub async fn list_by_board(pool: &SqlitePool, board_id: Uuid) -> Result<Vec<Item>, CoreError> {
    sqlx::query_as!(
        Item,
        "SELECT id AS \"id!: Uuid\", board_id AS \"board_id: Uuid\", type AS \"item_type!\", blob_id, x, y, width, height, rotation, z_index, group_id AS \"group_id: Uuid\", created_at AS \"created_at: DateTime<Utc>\", updated_at AS \"updated_at: DateTime<Utc>\" FROM items WHERE board_id = ? ORDER BY z_index ASC, id ASC",
        board_id,
    )
    .fetch_all(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Replaces an item's transform. Returns `false` when no item has `id`.
pub async fn update_transform(
    pool: &SqlitePool,
    id: Uuid,
    transform: ItemTransform,
) -> Result<bool, CoreError> {
    let result = sqlx::query!(
        "UPDATE items SET x = ?, y = ?, width = ?, height = ?, rotation = ?, z_index = ? \
         WHERE id = ?",
        transform.x,
        transform.y,
        transform.width,
        transform.height,
        transform.rotation,
        transform.z_index,
        id,
    )
    .execute(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Moves an item into a group (`None` ungroups). Returns `false` when no
/// item has `id`.
pub async fn set_group(
    pool: &SqlitePool,
    id: Uuid,
    group_id: Option<Uuid>,
) -> Result<bool, CoreError> {
    let result = sqlx::query!("UPDATE items SET group_id = ? WHERE id = ?", group_id, id)
        .execute(pool)
        .await
        .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Deletes an item; its metadata and tag links cascade. Returns `false` when
/// no item has `id`.
pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<bool, CoreError> {
    let result = sqlx::query!("DELETE FROM items WHERE id = ?", id)
        .execute(pool)
        .await
        .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Fetches an item's typed metadata payload; `None` when the item has no
/// metadata row.
pub async fn get_metadata(
    pool: &SqlitePool,
    item_id: Uuid,
) -> Result<Option<ItemMetadata>, CoreError> {
    let row = sqlx::query!(
        "SELECT json AS \"json!\" FROM item_metadata WHERE item_id = ?",
        item_id
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    row.map(|row| serde_json::from_str(&row.json).map_err(|error| CoreError::Db(error.to_string())))
        .transpose()
}

/// Inserts or replaces an item's typed metadata payload.
pub async fn set_metadata(
    pool: &SqlitePool,
    item_id: Uuid,
    metadata: &ItemMetadata,
) -> Result<(), CoreError> {
    let json = serde_json::to_string(metadata).map_err(|error| CoreError::Db(error.to_string()))?;
    sqlx::query!(
        "INSERT INTO item_metadata (item_id, json) VALUES (?, ?) \
         ON CONFLICT (item_id) DO UPDATE SET json = excluded.json",
        item_id,
        json,
    )
    .execute(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
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

    fn new_item(board_id: Uuid, z_index: i64) -> NewItem {
        NewItem {
            board_id,
            item_type: "image".to_string(),
            blob_id: None,
            x: 1.0,
            y: 2.0,
            width: 100.0,
            height: 50.0,
            rotation: 0.0,
            z_index,
            group_id: None,
        }
    }

    #[tokio::test]
    async fn create_get_round_trip() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        let item = create(&pools.write, new_item(board_id, 0))
            .await
            .expect("create");

        assert_eq!(item.board_id, board_id);
        assert_eq!(item.item_type, "image");
        assert_f64_eq(item.width, 100.0);
        assert!(item.blob_id.is_none());

        let fetched = get(&pools.read, item.id)
            .await
            .expect("get")
            .expect("exists");
        assert_eq!(fetched.id, item.id);
        assert_f64_eq(fetched.y, 2.0);
    }

    #[tokio::test]
    async fn list_by_board_orders_by_z_index() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        // Insert deliberately out of paint order.
        for z_index in [7, -3, 42, 0] {
            create(&pools.write, new_item(board_id, z_index))
                .await
                .expect("create");
        }

        let items = list_by_board(&pools.read, board_id).await.expect("list");
        let z_indexes: Vec<i64> = items.iter().map(|item| item.z_index).collect();
        assert_eq!(z_indexes, [-3, 0, 7, 42]);
    }

    #[tokio::test]
    async fn update_transform_and_set_group() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        let item = create(&pools.write, new_item(board_id, 0))
            .await
            .expect("create");

        let transform = ItemTransform {
            x: 5.0,
            y: 6.0,
            width: 200.0,
            height: 100.0,
            rotation: 90.0,
            z_index: 3,
        };
        assert!(
            update_transform(&pools.write, item.id, transform)
                .await
                .expect("update")
        );
        assert!(
            !update_transform(&pools.write, Uuid::now_v7(), transform)
                .await
                .expect("update missing")
        );

        let group = crate::db::groups::create(&pools.write, board_id, None, "g")
            .await
            .expect("create group");
        assert!(
            set_group(&pools.write, item.id, Some(group.id))
                .await
                .expect("set group")
        );

        let fetched = get(&pools.read, item.id)
            .await
            .expect("get")
            .expect("exists");
        assert_f64_eq(fetched.x, 5.0);
        assert_f64_eq(fetched.rotation, 90.0);
        assert_eq!(fetched.z_index, 3);
        assert_eq!(fetched.group_id, Some(group.id));
        assert!(fetched.updated_at >= item.updated_at);
    }

    #[tokio::test]
    async fn metadata_round_trip_and_replace() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        let item = create(&pools.write, new_item(board_id, 0))
            .await
            .expect("create");

        assert!(
            get_metadata(&pools.read, item.id)
                .await
                .expect("get metadata")
                .is_none()
        );

        let image = ItemMetadata::Image {
            phash: Some("abcd".to_string()),
            dominant_colors: vec!["#112233".to_string()],
        };
        set_metadata(&pools.write, item.id, &image)
            .await
            .expect("set metadata");
        assert_eq!(
            get_metadata(&pools.read, item.id).await.expect("get"),
            Some(image)
        );

        let embed = ItemMetadata::Embed {
            url: "https://example.com".to_string(),
            og_title: None,
        };
        set_metadata(&pools.write, item.id, &embed)
            .await
            .expect("replace metadata");
        assert_eq!(
            get_metadata(&pools.read, item.id).await.expect("get"),
            Some(embed)
        );
    }

    #[tokio::test]
    async fn delete_removes_item_and_metadata() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        let item = create(&pools.write, new_item(board_id, 0))
            .await
            .expect("create");
        set_metadata(
            &pools.write,
            item.id,
            &ItemMetadata::Video {
                duration_ms: 1_000,
                poster_blob: None,
            },
        )
        .await
        .expect("set metadata");

        assert!(delete(&pools.write, item.id).await.expect("delete"));
        assert!(!delete(&pools.write, item.id).await.expect("delete again"));
        assert!(get(&pools.read, item.id).await.expect("get").is_none());
        assert!(
            get_metadata(&pools.read, item.id)
                .await
                .expect("get metadata")
                .is_none()
        );
    }
}
