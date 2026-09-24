//! Tag CRUD and `item_tags` assignment helpers. Tag names are unique
//! case-insensitively (`UNIQUE COLLATE NOCASE`).
//!
//! See `items.rs` for why the column aliases carry `"name!: Type"`
//! overrides.

use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::CoreError;
use crate::models::Tag;

/// Creates a tag with a fresh `UUIDv7`. Fails on duplicate name
/// (case-insensitive); use [`get_or_create`] when dedup is wanted.
pub async fn create(pool: &SqlitePool, name: &str, color: Option<&str>) -> Result<Tag, CoreError> {
    let id = Uuid::now_v7();
    sqlx::query_as!(
        Tag,
        "INSERT INTO tags (id, name, color) VALUES (?, ?, ?) RETURNING id AS \"id!: Uuid\", name AS \"name!\", color",
        id,
        name,
        color,
    )
    .fetch_one(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Fetches a tag by name (case-insensitive); `None` when it does not exist.
pub async fn get_by_name(pool: &SqlitePool, name: &str) -> Result<Option<Tag>, CoreError> {
    sqlx::query_as!(
        Tag,
        "SELECT id AS \"id!: Uuid\", name AS \"name!\", color FROM tags WHERE name = ? COLLATE NOCASE",
        name,
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Returns the existing tag with `name`, or creates it.
pub async fn get_or_create(
    pool: &SqlitePool,
    name: &str,
    color: Option<&str>,
) -> Result<Tag, CoreError> {
    let id = Uuid::now_v7();
    sqlx::query!(
        "INSERT OR IGNORE INTO tags (id, name, color) VALUES (?, ?, ?)",
        id,
        name,
        color,
    )
    .execute(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    get_by_name(pool, name)
        .await?
        .ok_or_else(|| CoreError::Db(format!("tag {name:?} missing after insert-or-ignore")))
}

/// Lists all tags, ordered by name.
pub async fn list(executor: impl sqlx::SqliteExecutor<'_>) -> Result<Vec<Tag>, CoreError> {
    sqlx::query_as!(
        Tag,
        "SELECT id AS \"id!: Uuid\", name AS \"name!\", color FROM tags ORDER BY name COLLATE NOCASE"
    )
    .fetch_all(executor)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Deletes a tag; its `item_tags` links cascade. Returns `false` when no tag
/// has `id`.
pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<bool, CoreError> {
    let result = sqlx::query!("DELETE FROM tags WHERE id = ?", id)
        .execute(pool)
        .await
        .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Assigns a tag to an item. Returns `false` when the assignment already
/// existed (idempotent).
pub async fn add_to_item(
    pool: &SqlitePool,
    item_id: Uuid,
    tag_id: Uuid,
) -> Result<bool, CoreError> {
    let result = sqlx::query!(
        "INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)",
        item_id,
        tag_id,
    )
    .execute(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Removes a tag from an item. Returns `false` when the assignment did not
/// exist.
pub async fn remove_from_item(
    pool: &SqlitePool,
    item_id: Uuid,
    tag_id: Uuid,
) -> Result<bool, CoreError> {
    let result = sqlx::query!(
        "DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?",
        item_id,
        tag_id,
    )
    .execute(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Lists the tags assigned to an item, ordered by name.
pub async fn list_for_item(pool: &SqlitePool, item_id: Uuid) -> Result<Vec<Tag>, CoreError> {
    sqlx::query_as!(
        Tag,
        "SELECT t.id AS \"id!: Uuid\", t.name AS \"name!\", t.color FROM tags t \
         JOIN item_tags it ON it.tag_id = t.id \
         WHERE it.item_id = ? ORDER BY t.name COLLATE NOCASE",
        item_id,
    )
    .fetch_all(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Pools, boards, connect, items};

    async fn temp_pools_with_item() -> (tempfile::TempDir, Pools, Uuid) {
        let dir = tempfile::tempdir().expect("temp dir");
        let pools = connect(&dir.path().join("test.db")).await.expect("connect");
        let board = boards::create(&pools.write, "board")
            .await
            .expect("create board");
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
        (dir, pools, item.id)
    }

    #[tokio::test]
    async fn create_and_get_by_name_case_insensitive() {
        let (_dir, pools, _item_id) = temp_pools_with_item().await;
        let tag = create(&pools.write, "Landscapes", Some("#00ff00"))
            .await
            .expect("create");

        let fetched = get_by_name(&pools.read, "landscapes")
            .await
            .expect("get")
            .expect("exists");
        assert_eq!(fetched.id, tag.id);
        assert_eq!(fetched.color.as_deref(), Some("#00ff00"));

        assert!(create(&pools.write, "LANDSCAPES", None).await.is_err());
    }

    #[tokio::test]
    async fn get_or_create_dedups() {
        let (_dir, pools, _item_id) = temp_pools_with_item().await;
        let first = get_or_create(&pools.write, "dup", None)
            .await
            .expect("first");
        let second = get_or_create(&pools.write, "DUP", Some("#123456"))
            .await
            .expect("second");
        assert_eq!(first.id, second.id);

        let tags = list(&pools.read).await.expect("list");
        assert_eq!(tags.len(), 1);
    }

    #[tokio::test]
    async fn add_remove_list_for_item() {
        let (_dir, pools, item_id) = temp_pools_with_item().await;
        let tag = create(&pools.write, "mood", None)
            .await
            .expect("create tag");

        assert!(
            add_to_item(&pools.write, item_id, tag.id)
                .await
                .expect("add")
        );
        assert!(
            !add_to_item(&pools.write, item_id, tag.id)
                .await
                .expect("add again")
        );

        let tags = list_for_item(&pools.read, item_id)
            .await
            .expect("list for item");
        assert_eq!(tags.len(), 1);
        assert_eq!(tags[0].name, "mood");

        assert!(
            remove_from_item(&pools.write, item_id, tag.id)
                .await
                .expect("remove")
        );
        assert!(
            !remove_from_item(&pools.write, item_id, tag.id)
                .await
                .expect("remove again")
        );
        assert!(
            list_for_item(&pools.read, item_id)
                .await
                .expect("list")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn delete_cascades_item_links() {
        let (_dir, pools, item_id) = temp_pools_with_item().await;
        let tag = create(&pools.write, "temp", None)
            .await
            .expect("create tag");
        add_to_item(&pools.write, item_id, tag.id)
            .await
            .expect("add");

        assert!(delete(&pools.write, tag.id).await.expect("delete"));
        assert!(!delete(&pools.write, tag.id).await.expect("delete again"));
        assert!(
            list_for_item(&pools.read, item_id)
                .await
                .expect("list")
                .is_empty()
        );
        // The item itself survives.
        assert!(
            items::get(&pools.read, item_id)
                .await
                .expect("get item")
                .is_some()
        );
    }
}
