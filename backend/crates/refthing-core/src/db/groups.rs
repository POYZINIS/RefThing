//! Group CRUD. Groups nest via `parent_group_id` and style via
//! `bg_color`/`opacity` (Phase 5 hooks, stored now).
//!
//! See `items.rs` for why the column aliases carry `"name!: Type"`
//! overrides.

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::CoreError;
use crate::models::Group;

/// Creates a group with a fresh `UUIDv7` and returns it fully populated.
pub async fn create(
    pool: &SqlitePool,
    board_id: Uuid,
    parent_group_id: Option<Uuid>,
    name: &str,
) -> Result<Group, CoreError> {
    let id = Uuid::now_v7();
    sqlx::query_as!(
        Group,
        "INSERT INTO groups (id, board_id, parent_group_id, name) VALUES (?, ?, ?, ?) \
             RETURNING id AS \"id!: Uuid\", board_id AS \"board_id: Uuid\", parent_group_id AS \"parent_group_id: Uuid\", name AS \"name!\", collapsed AS \"collapsed: bool\", bg_color, opacity AS \"opacity!\", created_at AS \"created_at: DateTime<Utc>\", locked AS \"locked: bool\"",
        id,
        board_id,
        parent_group_id,
        name,
    )
    .fetch_one(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Fetches a group by id; `None` when it does not exist.
pub async fn get(pool: &SqlitePool, id: Uuid) -> Result<Option<Group>, CoreError> {
    sqlx::query_as!(
        Group,
        "SELECT id AS \"id!: Uuid\", board_id AS \"board_id: Uuid\", parent_group_id AS \"parent_group_id: Uuid\", name AS \"name!\", collapsed AS \"collapsed: bool\", bg_color, opacity AS \"opacity!\", created_at AS \"created_at: DateTime<Utc>\", locked AS \"locked: bool\" FROM groups WHERE id = ?",
        id,
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Lists a board's groups (both roots and nested), ordered by name.
pub async fn list_by_board(
    executor: impl sqlx::SqliteExecutor<'_>,
    board_id: Uuid,
) -> Result<Vec<Group>, CoreError> {
    sqlx::query_as!(
        Group,
        "SELECT id AS \"id!: Uuid\", board_id AS \"board_id: Uuid\", parent_group_id AS \"parent_group_id: Uuid\", name AS \"name!\", collapsed AS \"collapsed: bool\", bg_color, opacity AS \"opacity!\", created_at AS \"created_at: DateTime<Utc>\", locked AS \"locked: bool\" FROM groups WHERE board_id = ? ORDER BY name COLLATE NOCASE, id",
        board_id,
    )
    .fetch_all(executor)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Partially updates a group; `None` fields are left unchanged (so
/// `bg_color` cannot be cleared back to `NULL` through this function).
/// Returns `false` when no group has `id`.
pub async fn update(
    pool: &SqlitePool,
    id: Uuid,
    name: Option<&str>,
    collapsed: Option<bool>,
    bg_color: Option<&str>,
    opacity: Option<f64>,
) -> Result<bool, CoreError> {
    let result = sqlx::query!(
        "UPDATE groups SET \
             name = COALESCE(?, name), \
             collapsed = COALESCE(?, collapsed), \
             bg_color = COALESCE(?, bg_color), \
             opacity = COALESCE(?, opacity) \
         WHERE id = ?",
        name,
        collapsed,
        bg_color,
        opacity,
        id,
    )
    .execute(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Deletes a group; child groups cascade, member items are ungrouped
/// (`ON DELETE SET NULL`). Returns `false` when no group has `id`.
pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<bool, CoreError> {
    let result = sqlx::query!("DELETE FROM groups WHERE id = ?", id)
        .execute(pool)
        .await
        .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Pools, boards, connect, items};

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
    async fn create_get_round_trip_with_parent() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        let parent = create(&pools.write, board_id, None, "parent")
            .await
            .expect("create parent");
        let child = create(&pools.write, board_id, Some(parent.id), "child")
            .await
            .expect("create child");

        assert!(!child.collapsed);
        assert_f64_eq(child.opacity, 1.0);
        assert_eq!(child.parent_group_id, Some(parent.id));

        let fetched = get(&pools.read, child.id)
            .await
            .expect("get")
            .expect("exists");
        assert_eq!(fetched.name, "child");
        assert_eq!(fetched.board_id, board_id);
    }

    #[tokio::test]
    async fn list_by_board_returns_all_groups() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        create(&pools.write, board_id, None, "b")
            .await
            .expect("create b");
        create(&pools.write, board_id, None, "a")
            .await
            .expect("create a");

        let groups = list_by_board(&pools.read, board_id).await.expect("list");
        let names: Vec<&str> = groups.iter().map(|group| group.name.as_str()).collect();
        assert_eq!(names, ["a", "b"]);
    }

    #[tokio::test]
    async fn update_touches_only_set_fields() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        let group = create(&pools.write, board_id, None, "g")
            .await
            .expect("create");

        assert!(
            update(
                &pools.write,
                group.id,
                None,
                Some(true),
                Some("#ff0000"),
                None
            )
            .await
            .expect("update")
        );
        assert!(
            !update(&pools.write, Uuid::now_v7(), Some("x"), None, None, None)
                .await
                .expect("update missing")
        );

        let fetched = get(&pools.read, group.id)
            .await
            .expect("get")
            .expect("exists");
        assert_eq!(fetched.name, "g");
        assert!(fetched.collapsed);
        assert_eq!(fetched.bg_color.as_deref(), Some("#ff0000"));
        assert_f64_eq(fetched.opacity, 1.0);
    }

    #[tokio::test]
    async fn delete_ungroups_member_items() {
        let (_dir, pools, board_id) = temp_pools_with_board().await;
        let group = create(&pools.write, board_id, None, "g")
            .await
            .expect("create");
        let item = items::create(
            &pools.write,
            items::NewItem {
                board_id,
                item_type: "image".to_string(),
                blob_id: None,
                x: 0.0,
                y: 0.0,
                width: 10.0,
                height: 10.0,
                rotation: 0.0,
                z_index: 0,
                group_id: Some(group.id),
            },
        )
        .await
        .expect("create item");

        assert!(delete(&pools.write, group.id).await.expect("delete"));
        assert!(!delete(&pools.write, group.id).await.expect("delete again"));
        assert!(get(&pools.read, group.id).await.expect("get").is_none());

        let item = items::get(&pools.read, item.id)
            .await
            .expect("get item")
            .expect("exists");
        assert!(item.group_id.is_none());
    }
}
