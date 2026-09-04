//! Blob registry CRUD. Rows are keyed by content hash (64-char lowercase hex
//! SHA-256), so re-ingesting the same bytes is an idempotent no-op.
//!
//! See `items.rs` for why the column aliases carry `"name!: Type"`
//! overrides.

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;

use crate::error::CoreError;
use crate::models::Blob;

/// Registers a blob's metadata. Returns `false` when the hash was already
/// registered (dedup hit — the existing row is authoritative).
pub async fn insert_or_ignore(
    pool: &SqlitePool,
    hash: &str,
    original_filename: Option<&str>,
    mime_type: &str,
    byte_size: i64,
    width: Option<i64>,
    height: Option<i64>,
) -> Result<bool, CoreError> {
    let result = sqlx::query!(
        "INSERT OR IGNORE INTO blobs \
             (hash, original_filename, mime_type, byte_size, width, height) \
         VALUES (?, ?, ?, ?, ?, ?)",
        hash,
        original_filename,
        mime_type,
        byte_size,
        width,
        height,
    )
    .execute(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(result.rows_affected() > 0)
}

/// Fetches a blob's metadata by hash; `None` when it is not registered.
pub async fn get(pool: &SqlitePool, hash: &str) -> Result<Option<Blob>, CoreError> {
    sqlx::query_as!(
        Blob,
        "SELECT hash AS \"hash!\", original_filename, mime_type AS \"mime_type!\", byte_size AS \"byte_size!\", width, height, created_at AS \"created_at: DateTime<Utc>\" FROM blobs WHERE hash = ?",
        hash,
    )
    .fetch_optional(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))
}

/// Lists hashes no item references anymore — the sweep set for blob GC
/// (grace period and file deletion are the caller's concern).
pub async fn unreferenced_hashes(pool: &SqlitePool) -> Result<Vec<String>, CoreError> {
    let rows = sqlx::query!(
        "SELECT hash AS \"hash!\" FROM blobs \
         WHERE hash NOT IN (SELECT blob_id FROM items WHERE blob_id IS NOT NULL)",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;
    Ok(rows.into_iter().map(|row| row.hash).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Pools, boards, connect, items};

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    async fn temp_pools() -> (tempfile::TempDir, Pools) {
        let dir = tempfile::tempdir().expect("temp dir");
        let pools = connect(&dir.path().join("test.db")).await.expect("connect");
        (dir, pools)
    }

    #[tokio::test]
    async fn insert_or_ignore_dedups() {
        let (_dir, pools) = temp_pools().await;

        assert!(
            insert_or_ignore(
                &pools.write,
                HASH_A,
                Some("photo.png"),
                "image/png",
                12_345,
                Some(800),
                Some(600),
            )
            .await
            .expect("insert")
        );
        // Same hash, different metadata: no-op, original row wins.
        assert!(
            !insert_or_ignore(&pools.write, HASH_A, None, "image/jpeg", 1, None, None)
                .await
                .expect("reinsert")
        );

        let blob = get(&pools.read, HASH_A)
            .await
            .expect("get")
            .expect("exists");
        assert_eq!(blob.original_filename.as_deref(), Some("photo.png"));
        assert_eq!(blob.mime_type, "image/png");
        assert_eq!(blob.byte_size, 12_345);
        assert_eq!(blob.width, Some(800));
    }

    #[tokio::test]
    async fn get_missing_returns_none() {
        let (_dir, pools) = temp_pools().await;
        assert!(get(&pools.read, HASH_B).await.expect("get").is_none());
    }

    #[tokio::test]
    async fn unreferenced_hashes_excludes_in_use_blobs() {
        let (_dir, pools) = temp_pools().await;
        insert_or_ignore(&pools.write, HASH_A, None, "image/png", 1, None, None)
            .await
            .expect("insert a");
        insert_or_ignore(&pools.write, HASH_B, None, "image/png", 1, None, None)
            .await
            .expect("insert b");

        assert_eq!(
            unreferenced_hashes(&pools.read)
                .await
                .expect("gc sweep")
                .len(),
            2
        );

        let board = boards::create(&pools.write, "board")
            .await
            .expect("create board");
        let item = items::create(
            &pools.write,
            items::NewItem {
                board_id: board.id,
                item_type: "image".to_string(),
                blob_id: Some(HASH_A.to_string()),
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

        assert_eq!(
            unreferenced_hashes(&pools.read).await.expect("gc sweep"),
            vec![HASH_B]
        );

        items::delete(&pools.write, item.id)
            .await
            .expect("delete item");
        assert_eq!(
            unreferenced_hashes(&pools.read)
                .await
                .expect("gc sweep")
                .len(),
            2
        );
    }
}
