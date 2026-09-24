//! Immutable rollback points, captured and restored in single transactions.
//! Blob files and global tag definitions are shared resources, not board state.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use refthing_core::{error::CoreError, models};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{SqliteConnection, SqlitePool};
use uuid::Uuid;

use crate::dto;
use crate::events;
use crate::services::{board_service, views};

/// How many recent snapshots to retain per board.
pub const PRUNE_KEEP: i64 = 10;

fn failure(error: impl std::fmt::Display) -> CoreError {
    CoreError::Db(error.to_string())
}

/// New snapshots include saved views. Legacy snapshots preserve current views
/// because those snapshots did not capture them.
#[derive(Serialize, Deserialize)]
struct SavedState {
    #[serde(flatten)]
    board: dto::BoardSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    views: Option<Vec<dto::BoardView>>,
}

/// Captures one coherent board state and prunes older versions atomically.
/// Returns `None` when the board does not exist.
pub async fn capture(
    pool: &SqlitePool,
    board_id: Uuid,
    label: &str,
) -> Result<Option<BoardSnapshot>, CoreError> {
    let mut tx = pool.begin().await.map_err(failure)?;
    let Some(board) = board_service::snapshot_on_connection(&mut tx, board_id).await? else {
        return Ok(None);
    };
    let views = sqlx::query_as::<_, models::BoardView>(
        "SELECT * FROM board_views WHERE board_id = ? ORDER BY created_at, id",
    )
    .bind(board_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(failure)?
    .into_iter()
    .map(views::view_dto)
    .collect();
    let data = serde_json::to_value(SavedState {
        board,
        views: Some(views),
    })
    .map_err(failure)?;

    // Millisecond collisions must not replace an earlier immutable snapshot.
    let latest: Option<i64> =
        sqlx::query_scalar("SELECT MAX(created_at) FROM board_snapshots WHERE board_id = ?")
            .bind(board_id)
            .fetch_one(&mut *tx)
            .await
            .map_err(failure)?;
    let created_at = Utc::now()
        .timestamp_millis()
        .max(latest.unwrap_or_default().saturating_add(1));
    sqlx::query(
        "INSERT INTO board_snapshots (board_id, created_at, label, data) VALUES (?, ?, ?, ?)",
    )
    .bind(board_id)
    .bind(created_at)
    .bind(label)
    .bind(&data)
    .execute(&mut *tx)
    .await
    .map_err(failure)?;
    sqlx::query(
        "DELETE FROM board_snapshots WHERE board_id = ? AND created_at IN (
            SELECT created_at FROM board_snapshots WHERE board_id = ?
            ORDER BY created_at DESC LIMIT -1 OFFSET ?
         )",
    )
    .bind(board_id)
    .bind(board_id)
    .bind(PRUNE_KEEP)
    .execute(&mut *tx)
    .await
    .map_err(failure)?;
    tx.commit().await.map_err(failure)?;
    Ok(Some(BoardSnapshot {
        board_id,
        created_at,
        label: label.to_string(),
        data,
    }))
}

/// Lists saved rollback points, newest first. Malformed stored JSON is an
/// error rather than a silently empty board.
pub async fn list(pool: &SqlitePool, board_id: Uuid) -> Result<Vec<BoardSnapshot>, CoreError> {
    sqlx::query_as::<_, BoardSnapshot>(
        "SELECT board_id, created_at, label, data FROM board_snapshots \
         WHERE board_id = ? ORDER BY created_at DESC",
    )
    .bind(board_id)
    .fetch_all(pool)
    .await
    .map_err(failure)
}

/// Restores all captured board-owned state atomically. Returns the new,
/// monotonic event sequence, or `None` for a missing snapshot. A rollback is
/// a new edit: historical sequences and the event log are never rewound.
pub async fn restore(
    pool: &SqlitePool,
    board_id: Uuid,
    created_at: i64,
) -> Result<Option<i64>, CoreError> {
    let mut tx = pool.begin().await.map_err(failure)?;
    let data: Option<String> = sqlx::query_scalar(
        "SELECT data FROM board_snapshots WHERE board_id = ? AND created_at = ?",
    )
    .bind(board_id)
    .bind(created_at)
    .fetch_optional(&mut *tx)
    .await
    .map_err(failure)?;
    let Some(data) = data else {
        return Ok(None);
    };
    let saved: SavedState = serde_json::from_str(&data).map_err(failure)?;
    validate(&saved, board_id)?;

    // Older mutation endpoints could create cross-board group references.
    // Never let a group's cascading delete modify a different board.
    let external_references: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM groups g JOIN groups parent ON parent.id = g.parent_group_id \
         WHERE parent.board_id = ? AND g.board_id != ?) OR \
         EXISTS(SELECT 1 FROM items i JOIN groups g ON g.id = i.group_id \
         WHERE g.board_id = ? AND i.board_id != ?)",
    )
    .bind(board_id)
    .bind(board_id)
    .bind(board_id)
    .bind(board_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(failure)?;
    if external_references != 0 {
        return Err(failure("cannot restore groups referenced by another board"));
    }

    sqlx::query("DELETE FROM items WHERE board_id = ?")
        .bind(board_id)
        .execute(&mut *tx)
        .await
        .map_err(failure)?;
    sqlx::query("DELETE FROM notes WHERE board_id = ?")
        .bind(board_id)
        .execute(&mut *tx)
        .await
        .map_err(failure)?;
    // Break local parent links first, avoiding SQLite's recursive cascade
    // depth limit for large hierarchies.
    sqlx::query("UPDATE groups SET parent_group_id = NULL WHERE board_id = ?")
        .bind(board_id)
        .execute(&mut *tx)
        .await
        .map_err(failure)?;
    sqlx::query("DELETE FROM groups WHERE board_id = ?")
        .bind(board_id)
        .execute(&mut *tx)
        .await
        .map_err(failure)?;

    restore_groups(&mut tx, &saved.board.groups).await?;
    restore_items(&mut tx, &saved.board.items).await?;
    restore_notes(&mut tx, &saved.board.notes).await?;
    restore_tags(&mut tx, &saved.board).await?;
    if let Some(views) = &saved.views {
        restore_views(&mut tx, board_id, views).await?;
    }
    sqlx::query("UPDATE boards SET name = ?, viewport_state = ? WHERE id = ?")
        .bind(&saved.board.board.name)
        .bind(&saved.board.board.viewport_state)
        .bind(board_id)
        .execute(&mut *tx)
        .await
        .map_err(failure)?;

    // Empty operations are the existing client protocol for a mutation that
    // requires complete hydration (both live sockets and replay/catch-up).
    let seq = events::append_event(&mut tx, board_id, None, &json!([]))
        .await
        .map_err(failure)?;
    tx.commit().await.map_err(failure)?;
    Ok(Some(seq))
}

fn validate(saved: &SavedState, board_id: Uuid) -> Result<(), CoreError> {
    let board = &saved.board;
    if board.board.id != board_id || board.seq != board.board.seq {
        return Err(failure(
            "snapshot board identity or sequence is inconsistent",
        ));
    }
    let mut item_ids = HashSet::new();
    let mut group_ids = HashSet::new();
    let mut note_ids = HashSet::new();
    let mut view_ids = HashSet::new();
    for group in &board.groups {
        if group.board_id != board_id || !group_ids.insert(group.id) {
            return Err(failure("invalid snapshot group identity"));
        }
        timestamp(group.created_at)?;
    }
    let parents: HashMap<_, _> = board
        .groups
        .iter()
        .map(|group| (group.id, group.parent_group_id))
        .collect();
    let mut visited = HashSet::new();
    for group in &board.groups {
        let mut path = HashSet::new();
        let mut current = Some(group.id);
        while let Some(id) = current {
            if visited.contains(&id) {
                break;
            }
            if !path.insert(id) {
                return Err(failure("snapshot group hierarchy contains a cycle"));
            }
            current = *parents
                .get(&id)
                .ok_or_else(|| failure("snapshot group parent is missing"))?;
        }
        visited.extend(path);
    }
    for item in &board.items {
        if item.board_id != board_id
            || !item_ids.insert(item.id)
            || item.group_id.is_some_and(|id| !group_ids.contains(&id))
        {
            return Err(failure("invalid snapshot item identity or group"));
        }
        timestamp(item.created_at)?;
        timestamp(item.updated_at)?;
    }
    for note in &board.notes {
        if note.board_id != board_id || !note_ids.insert(note.id) {
            return Err(failure("invalid snapshot note identity"));
        }
        timestamp(note.created_at)?;
        timestamp(note.updated_at)?;
    }
    let mut tag_ids = HashSet::new();
    for tag in &board.tags {
        if !tag_ids.insert(tag.id) {
            return Err(failure("duplicate snapshot tag identity"));
        }
    }
    for (item_id, tags) in &board.item_tags {
        if !item_ids.contains(item_id) || tags.iter().any(|id| !tag_ids.contains(id)) {
            return Err(failure(
                "snapshot tag assignment references a missing item or tag",
            ));
        }
    }
    for view in saved.views.iter().flatten() {
        if view.board_id != board_id || !view_ids.insert(view.id) {
            return Err(failure("invalid snapshot view identity"));
        }
        timestamp(view.created_at)?;
        timestamp(view.updated_at)?;
    }
    Ok(())
}

fn timestamp(milliseconds: i64) -> Result<DateTime<Utc>, CoreError> {
    DateTime::from_timestamp_millis(milliseconds)
        .ok_or_else(|| failure("snapshot timestamp is out of range"))
}

async fn restore_groups(
    connection: &mut SqliteConnection,
    groups: &[dto::Group],
) -> Result<(), CoreError> {
    // Insert every group without its parent, then connect the hierarchy.
    // This handles child-first snapshots without disabling foreign keys.
    for group in groups {
        sqlx::query(
            "INSERT INTO groups (id, board_id, name, collapsed, bg_color, opacity, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(group.id)
        .bind(group.board_id)
        .bind(&group.name)
        .bind(group.collapsed)
        .bind(&group.bg_color)
        .bind(group.opacity)
        .bind(timestamp(group.created_at)?)
        .execute(&mut *connection)
        .await
        .map_err(failure)?;
    }
    for group in groups {
        if let Some(parent) = group.parent_group_id {
            sqlx::query("UPDATE groups SET parent_group_id = ? WHERE id = ?")
                .bind(parent)
                .bind(group.id)
                .execute(&mut *connection)
                .await
                .map_err(failure)?;
        }
    }
    Ok(())
}

async fn restore_items(
    connection: &mut SqliteConnection,
    items: &[dto::Item],
) -> Result<(), CoreError> {
    for item in items {
        // Binding typed UUIDs matches all core/API paths. Plain INSERT also
        // rejects any ID collision with another board instead of overwriting it.
        sqlx::query(
            "INSERT INTO items (id, board_id, type, blob_id, x, y, width, height, rotation, \
             z_index, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(item.id)
        .bind(item.board_id)
        .bind(&item.item_type)
        .bind(&item.blob_hash)
        .bind(item.x)
        .bind(item.y)
        .bind(item.width)
        .bind(item.height)
        .bind(item.rotation)
        .bind(item.z_index)
        .bind(item.group_id)
        .bind(timestamp(item.created_at)?)
        .bind(timestamp(item.updated_at)?)
        .execute(&mut *connection)
        .await
        .map_err(failure)?;
        sqlx::query("INSERT INTO item_metadata (item_id, json) VALUES (?, ?)")
            .bind(item.id)
            .bind(&item.metadata)
            .execute(&mut *connection)
            .await
            .map_err(failure)?;
    }
    Ok(())
}

async fn restore_notes(
    connection: &mut SqliteConnection,
    notes: &[dto::Note],
) -> Result<(), CoreError> {
    for note in notes {
        sqlx::query(
            "INSERT INTO notes (id, board_id, x, y, width, height, rotation, z_index, \
             content_json, bg_color, opacity, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(note.id)
        .bind(note.board_id)
        .bind(note.x)
        .bind(note.y)
        .bind(note.width)
        .bind(note.height)
        .bind(note.rotation)
        .bind(note.z_index)
        .bind(&note.content_json)
        .bind(&note.bg_color)
        .bind(note.opacity)
        .bind(timestamp(note.created_at)?)
        .bind(timestamp(note.updated_at)?)
        .execute(&mut *connection)
        .await
        .map_err(failure)?;
    }
    Ok(())
}

async fn restore_tags(
    connection: &mut SqliteConnection,
    board: &dto::BoardSnapshot,
) -> Result<(), CoreError> {
    let tags: HashMap<_, _> = board.tags.iter().map(|tag| (tag.id, tag)).collect();
    let mut mapped_ids = HashMap::new();
    for (item_id, tag_ids) in &board.item_tags {
        for id in tag_ids {
            let mapped = if let Some(mapped) = mapped_ids.get(id) {
                *mapped
            } else {
                let tag = tags[id];
                // Global definitions can be used by other boards. Keep an
                // existing ID or same-name tag, including its current color.
                let existing: Option<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM tags WHERE id = ? OR name = ? COLLATE NOCASE \
                     ORDER BY (id = ?) DESC LIMIT 1",
                )
                .bind(id)
                .bind(&tag.name)
                .bind(id)
                .fetch_optional(&mut *connection)
                .await
                .map_err(failure)?;
                let mapped = if let Some(existing) = existing {
                    existing
                } else {
                    sqlx::query("INSERT INTO tags (id, name, color) VALUES (?, ?, ?)")
                        .bind(tag.id)
                        .bind(&tag.name)
                        .bind(&tag.color)
                        .execute(&mut *connection)
                        .await
                        .map_err(failure)?;
                    tag.id
                };
                mapped_ids.insert(*id, mapped);
                mapped
            };
            sqlx::query("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)")
                .bind(item_id)
                .bind(mapped)
                .execute(&mut *connection)
                .await
                .map_err(failure)?;
        }
    }
    Ok(())
}

async fn restore_views(
    connection: &mut SqliteConnection,
    board_id: Uuid,
    views: &[dto::BoardView],
) -> Result<(), CoreError> {
    sqlx::query("DELETE FROM board_views WHERE board_id = ?")
        .bind(board_id)
        .execute(&mut *connection)
        .await
        .map_err(failure)?;
    for view in views {
        sqlx::query(
            "INSERT INTO board_views (id, board_id, name, viewport, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(view.id)
        .bind(view.board_id)
        .bind(&view.name)
        .bind(&view.viewport)
        .bind(timestamp(view.created_at)?)
        .bind(timestamp(view.updated_at)?)
        .execute(&mut *connection)
        .await
        .map_err(failure)?;
    }
    Ok(())
}

/// One saved rollback point, returned to clients.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct BoardSnapshot {
    pub board_id: Uuid,
    pub created_at: i64,
    pub label: String,
    pub data: Value,
}
