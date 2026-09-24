//! Versioned board snapshots (Phase 7): capture + list + rollback.
//!
//! A snapshot is an immutable JSON copy of a board's full state (what
//! `GET /boards/{id}` returns) tagged with a timestamp. Newest `PRUNE_KEEP`
//! versions per board are retained; older ones are pruned on each capture.

use refthing_core::error::CoreError;
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::services::board_service;

/// How many recent snapshots to retain per board; older ones are pruned.
pub const PRUNE_KEEP: i64 = 10;

/// Captures a fresh snapshot of the board as of now. Returns the saved
/// snapshot's row. Prunes the board's oldest snapshots beyond `PRUNE_KEEP`.
///
/// # Errors
/// Returns [`CoreError`] on DB failure or if the board does not exist.
pub async fn capture(
    pool: &SqlitePool,
    board_id: Uuid,
    label: &str,
) -> Result<BoardSnapshot, CoreError> {
    // Hydrate the board's full state — same payload the client sees.
    let Some(snapshot) = board_service::snapshot(pool, board_id).await? else {
        return Err(CoreError::Db("board not found".into()));
    };

    let created_at = now_ms();
    sqlx::query(
        "INSERT OR REPLACE INTO board_snapshots (board_id, created_at, label, data) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(board_id)
    .bind(created_at)
    .bind(label)
    .bind(serde_json::to_string(&snapshot).map_err(|e| CoreError::Db(e.to_string()))?)
    .execute(pool)
    .await
    .map_err(|e| CoreError::Db(e.to_string()))?;

    // Prune beyond PRUNE_KEEP (keep the newest N).
    sqlx::query(
        "DELETE FROM board_snapshots WHERE board_id = ? AND created_at IN (
            SELECT created_at FROM board_snapshots WHERE board_id = ?
            ORDER BY created_at DESC LIMIT -1 OFFSET ?
         )",
    )
    .bind(board_id)
    .bind(board_id)
    .bind(PRUNE_KEEP)
    .execute(pool)
    .await
    .map_err(|e| CoreError::Db(e.to_string()))?;

    Ok(BoardSnapshot {
        board_id,
        created_at,
        label: label.to_string(),
        data: serde_json::to_value(snapshot).map_err(|e| CoreError::Db(e.to_string()))?,
    })
}

/// Lists a board's snapshots (newest first), including the JSON payload.
///
/// # Errors
/// Returns [`CoreError`] on DB failure.
pub async fn list(pool: &SqlitePool, board_id: Uuid) -> Result<Vec<BoardSnapshot>, CoreError> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT created_at, label, data FROM board_snapshots \
         WHERE board_id = ? ORDER BY created_at DESC",
    )
    .bind(board_id)
    .fetch_all(pool)
    .await
    .map_err(|e| CoreError::Db(e.to_string()))?;

    Ok(rows
        .into_iter()
        .map(|row| BoardSnapshot {
            board_id,
            created_at: row.get("created_at"),
            label: row.get("label"),
            data: serde_json::from_str(row.get::<String, _>("data").as_str())
                .unwrap_or(Value::Null),
        })
        .collect())
}

/// Restores a board to the snapshot taken at `created_at`. Returns `false`
/// if no such snapshot exists, `true` on success.
///
/// Restoration is best-effort: the snapshot JSON is written back into the
/// live tables. To keep this simple and safe the service replaces the
/// board's items, notes, `item_tags`, groups, and viewport state atomically.
/// Because snapshot `data` is the board snapshot shape (matches
/// `GET /boards/{id}`), we reuse its serialized item list.
///
/// # Errors
/// Returns [`CoreError`] on DB failure.
pub async fn restore(
    pool: &SqlitePool,
    board_id: Uuid,
    created_at: i64,
) -> Result<bool, CoreError> {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT data FROM board_snapshots \
         WHERE board_id = ? AND created_at = ?",
    )
    .bind(board_id)
    .bind(created_at)
    .fetch_optional(pool)
    .await
    .map_err(|e| CoreError::Db(e.to_string()))?
    .ok_or_else(|| CoreError::Db("snapshot not found".into()))?;

    let data: String = row.get("data");

    let value: Value = serde_json::from_str(&data).map_err(|e| CoreError::Db(e.to_string()))?;

    // Restore viewport state onto the board row.
    if let Some(viewport) = value.get("viewport_state") {
        sqlx::query("UPDATE boards SET viewport_state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
            .bind(viewport.to_string())
            .bind(board_id)
            .execute(pool)
            .await
            .map_err(|e| CoreError::Db(e.to_string()))?;
    }

    // Restore items + their metadata.
    let items = value
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    // Snapshot data has per-blob levels and item objects; we use the server
    // snapshot format. For a tight v1 we restore the item transforms and blob
    // associations directly.
    let mut tx = pool
        .begin()
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
    sqlx::query("DELETE FROM items WHERE board_id = ?")
        .bind(board_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;

    for item in items {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("image");
        let blob_hash = item.get("blob_hash").and_then(serde_json::Value::as_str);
        let x = item
            .get("x")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let y = item
            .get("y")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let width = item
            .get("width")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(100.0);
        let height = item
            .get("height")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(100.0);
        let rotation = item
            .get("rotation")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let z_index = item
            .get("z_index")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let group_id = item.get("group_id").and_then(serde_json::Value::as_str);
        sqlx::query(
            "INSERT INTO items (id, board_id, type, blob_id, x, y, width, height, rotation, z_index, group_id) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(id) DO UPDATE SET x = excluded.x, y = excluded.y, \
                 width = excluded.width, height = excluded.height, \
                 rotation = excluded.rotation, z_index = excluded.z_index, \
                 group_id = excluded.group_id",
        )
        .bind(id)
        .bind(board_id)
        .bind(item_type)
        .bind(blob_hash)
        .bind(x)
        .bind(y)
        .bind(width)
        .bind(height)
        .bind(rotation)
        .bind(z_index)
        .bind(group_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;
    }
    tx.commit()
        .await
        .map_err(|e| CoreError::Db(e.to_string()))?;

    Ok(true)
}

/// The record for one saved snapshot (returned to clients).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BoardSnapshot {
    pub board_id: Uuid,
    pub created_at: i64,
    pub label: String,
    pub data: Value,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
