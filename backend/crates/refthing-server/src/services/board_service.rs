//! Board-scoped orchestration: snapshot hydration plus every mutation that
//! must atomically bump `boards.seq` and append to `board_events`.
//!
//! Every mutation here runs INSIDE the caller's transaction on `Pools::write`
//! (mutate → [`events::append_event`] → the handler commits and broadcasts).
//! Nothing here holds a transaction across non-DB work.
//!
//! The snapshot's per-blob `levels` map carries every `ready`
//! `blob_derivatives` level (plus a `full` fallback from the blob's intrinsic
//! dimensions for blobs whose pyramid job has not run yet);
//! [`snapshot_blobs`] is the single place that map is built.

use std::collections::HashMap;

use refthing_core::db::{boards, groups, items, notes, tags};
use refthing_core::error::CoreError;
use refthing_core::models;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{SqliteConnection, SqlitePool, SqliteTransaction};
use uuid::Uuid;

use crate::dto::{self, BlobLevel};
use crate::events;
use crate::services::{self, board_dto, group_dto, item_dto, note_dto, summary_dto, tag_dto};

fn core_err(error: &sqlx::Error) -> CoreError {
    CoreError::Db(error.to_string())
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/// Lists all boards for the picker.
pub async fn list_boards(pool: &SqlitePool) -> Result<Vec<dto::BoardSummary>, CoreError> {
    let summaries = boards::list(pool).await?;
    Ok(summaries.into_iter().map(summary_dto).collect())
}

/// Full hydration payload for `GET /api/boards/{id}`; `None` when the board
/// does not exist.
pub async fn snapshot(
    pool: &SqlitePool,
    board_id: Uuid,
) -> Result<Option<dto::BoardSnapshot>, CoreError> {
    let mut conn = pool.acquire().await.map_err(|error| core_err(&error))?;
    snapshot_on_connection(&mut conn, board_id).await
}

/// [`snapshot`] on an existing connection, so callers inside a transaction
/// (e.g. versioned snapshot capture) read one coherent board state.
pub async fn snapshot_on_connection(
    conn: &mut SqliteConnection,
    board_id: Uuid,
) -> Result<Option<dto::BoardSnapshot>, CoreError> {
    let Some(board) = boards::get(&mut *conn, board_id).await? else {
        return Ok(None);
    };

    let metadata = snapshot_metadata(conn, board_id).await?;
    let items = items::list_by_board(&mut *conn, board_id)
        .await?
        .into_iter()
        .map(|item| {
            let metadata = metadata.get(&item.id).cloned().unwrap_or_else(|| json!({}));
            item_dto(item, metadata)
        })
        .collect();

    Ok(Some(dto::BoardSnapshot {
        seq: board.seq,
        board: board_dto(board),
        items,
        groups: groups::list_by_board(&mut *conn, board_id)
            .await?
            .into_iter()
            .map(group_dto)
            .collect(),
        notes: notes::list_by_board(&mut *conn, board_id)
            .await?
            .into_iter()
            .map(note_dto)
            .collect(),
        tags: tags::list(&mut *conn)
            .await?
            .into_iter()
            .map(tag_dto)
            .collect(),
        item_tags: snapshot_item_tags(conn, board_id).await?,
        blobs: snapshot_blobs(conn, board_id).await?,
    }))
}

/// `item_id` → merged `item_metadata.json` payload, one query for the board.
async fn snapshot_metadata(
    conn: &mut SqliteConnection,
    board_id: Uuid,
) -> Result<HashMap<Uuid, Value>, CoreError> {
    let rows: Vec<(Uuid, Value)> = sqlx::query_as(
        "SELECT m.item_id, m.json FROM item_metadata m \
         JOIN items i ON i.id = m.item_id WHERE i.board_id = ?",
    )
    .bind(board_id)
    .fetch_all(conn)
    .await
    .map_err(|error| core_err(&error))?;
    Ok(rows.into_iter().collect())
}

/// `item_id` → assigned `tag_id`s, one query for the board.
async fn snapshot_item_tags(
    conn: &mut SqliteConnection,
    board_id: Uuid,
) -> Result<HashMap<Uuid, Vec<Uuid>>, CoreError> {
    let rows: Vec<(Uuid, Uuid)> = sqlx::query_as(
        "SELECT it.item_id, it.tag_id FROM item_tags it \
         JOIN items i ON i.id = it.item_id WHERE i.board_id = ? \
         ORDER BY it.item_id, it.tag_id",
    )
    .bind(board_id)
    .fetch_all(conn)
    .await
    .map_err(|error| core_err(&error))?;

    let mut map: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
    for (item_id, tag_id) in rows {
        map.entry(item_id).or_default().push(tag_id);
    }
    Ok(map)
}

/// One blob as the snapshot describes it (ready levels, or a synthesized
/// `full`) — for responses that hand a client a new item without a refetch.
pub(crate) async fn blob_info(
    pool: &sqlx::SqlitePool,
    hash: &str,
) -> Result<Option<dto::BlobInfo>, CoreError> {
    let Some(blob) = sqlx::query_as::<_, models::Blob>(
        "SELECT hash, original_filename, mime_type, byte_size, width, height, created_at \
         FROM blobs WHERE hash = ?",
    )
    .bind(hash)
    .fetch_optional(pool)
    .await
    .map_err(|error| core_err(&error))?
    else {
        return Ok(None);
    };
    let rows: Vec<(String, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT level, width, height FROM blob_derivatives \
         WHERE blob_hash = ? AND status = 'ready'",
    )
    .bind(hash)
    .fetch_all(pool)
    .await
    .map_err(|error| core_err(&error))?;
    let mut levels: HashMap<String, BlobLevel> = rows
        .into_iter()
        .filter_map(|(level, width, height)| {
            Some((
                level,
                BlobLevel {
                    width: width?,
                    height: height?,
                },
            ))
        })
        .collect();
    if !levels.contains_key("full")
        && let (Some(width), Some(height)) = (blob.width, blob.height)
    {
        levels.insert("full".to_string(), BlobLevel { width, height });
    }
    Ok(Some(dto::BlobInfo {
        hash: blob.hash,
        original_filename: blob.original_filename,
        mime_type: blob.mime_type,
        byte_size: blob.byte_size,
        width: blob.width,
        height: blob.height,
        created_at: services::ms(blob.created_at),
        levels,
    }))
}

/// Blobs referenced by the board's items. `levels` holds every `ready`
/// `blob_derivatives` level (`thumb`/`small`/`medium`/`full`), falling back
/// to a synthesized `full` from the blob's intrinsic dimensions when the
/// pyramid job has not recorded rows yet.
async fn snapshot_blobs(
    conn: &mut SqliteConnection,
    board_id: Uuid,
) -> Result<Vec<dto::BlobInfo>, CoreError> {
    let blobs = sqlx::query_as::<_, models::Blob>(
        "SELECT DISTINCT b.hash, b.original_filename, b.mime_type, b.byte_size, \
         b.width, b.height, b.created_at \
         FROM blobs b JOIN items i ON i.blob_id = b.hash WHERE i.board_id = ?",
    )
    .bind(board_id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|error| core_err(&error))?;

    // blob_hash → level → dims, one query for the whole board.
    let derivative_rows: Vec<(String, String, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT DISTINCT d.blob_hash, d.level, d.width, d.height \
         FROM blob_derivatives d JOIN items i ON i.blob_id = d.blob_hash \
         WHERE i.board_id = ? AND d.status = 'ready'",
    )
    .bind(board_id)
    .fetch_all(conn)
    .await
    .map_err(|error| core_err(&error))?;
    let mut derivative_levels: HashMap<String, HashMap<String, BlobLevel>> = HashMap::new();
    for (hash, level, width, height) in derivative_rows {
        if let (Some(width), Some(height)) = (width, height) {
            derivative_levels
                .entry(hash)
                .or_default()
                .insert(level, BlobLevel { width, height });
        }
    }

    Ok(blobs
        .into_iter()
        .map(|blob| {
            let mut levels = derivative_levels.remove(&blob.hash).unwrap_or_default();
            if !levels.contains_key("full")
                && let (Some(width), Some(height)) = (blob.width, blob.height)
            {
                levels.insert("full".to_string(), BlobLevel { width, height });
            }
            dto::BlobInfo {
                hash: blob.hash,
                original_filename: blob.original_filename,
                mime_type: blob.mime_type,
                byte_size: blob.byte_size,
                width: blob.width,
                height: blob.height,
                created_at: services::ms(blob.created_at),
                levels,
            }
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Request bodies (shared by the route handlers via the lib crate)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct NewBoard {
    pub name: String,
}

/// Board patch. `viewport_state` is a double option so an explicit `null`
/// resets to the default view while a missing field leaves it unchanged.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct BoardPatch {
    pub name: Option<String>,
    #[serde(deserialize_with = "services::double_option")]
    pub viewport_state: Option<Option<Value>>,
    /// Echo-suppression token, like a batch's `client_id`: the sender
    /// recognises its own viewport saves instead of refetching the board.
    pub client_id: Option<String>,
}

impl BoardPatch {
    /// The event/diff origin: the sender's client id, if it sent one.
    #[must_use]
    pub fn origin(&self) -> Option<&str> {
        self.client_id.as_deref().filter(|id| !id.is_empty())
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.name.is_none() && self.viewport_state.is_none()
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct NewGroup {
    pub name: String,
    pub parent_group_id: Option<Uuid>,
}

/// Group patch. `parent_group_id` is a double option: `null` moves the group
/// to the root.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct GroupPatch {
    pub name: Option<String>,
    pub collapsed: Option<bool>,
    #[serde(deserialize_with = "services::double_option")]
    pub parent_group_id: Option<Option<Uuid>>,
    #[serde(deserialize_with = "services::double_option")]
    pub bg_color: Option<Option<String>>,
    pub opacity: Option<f64>,
}

impl GroupPatch {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.collapsed.is_none()
            && self.parent_group_id.is_none()
            && self.bg_color.is_none()
            && self.opacity.is_none()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewNote {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub rotation: f64,
    /// Omitted → top of the board's shared item/note paint order.
    #[serde(default)]
    pub z_index: Option<i64>,
    #[serde(default = "empty_content")]
    pub content_json: Value,
    pub bg_color: Option<String>,
    pub opacity: Option<f64>,
}

fn empty_content() -> Value {
    json!({})
}

/// Note patch. `bg_color` is a double option: `null` clears the color.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct NotePatch {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub rotation: Option<f64>,
    pub z_index: Option<i64>,
    pub content_json: Option<Value>,
    #[serde(deserialize_with = "services::double_option")]
    pub bg_color: Option<Option<String>>,
    pub opacity: Option<f64>,
}

impl NotePatch {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.x.is_none()
            && self.y.is_none()
            && self.width.is_none()
            && self.height.is_none()
            && self.rotation.is_none()
            && self.z_index.is_none()
            && self.content_json.is_none()
            && self.bg_color.is_none()
            && self.opacity.is_none()
    }
}

// ---------------------------------------------------------------------------
// Mutations (caller's transaction on Pools::write)
// ---------------------------------------------------------------------------

async fn board_exists(tx: &mut SqliteTransaction<'_>, board_id: Uuid) -> Result<bool, sqlx::Error> {
    let row = sqlx::query("SELECT 1 AS one FROM boards WHERE id = ?")
        .bind(board_id)
        .fetch_optional(&mut **tx)
        .await?;
    Ok(row.is_some())
}

async fn fetch_board(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
) -> Result<models::Board, sqlx::Error> {
    sqlx::query_as::<_, models::Board>("SELECT * FROM boards WHERE id = ?")
        .bind(board_id)
        .fetch_one(&mut **tx)
        .await
}

async fn fetch_group(
    tx: &mut SqliteTransaction<'_>,
    group_id: Uuid,
) -> Result<models::Group, sqlx::Error> {
    sqlx::query_as::<_, models::Group>("SELECT * FROM groups WHERE id = ?")
        .bind(group_id)
        .fetch_one(&mut **tx)
        .await
}

async fn fetch_note(
    tx: &mut SqliteTransaction<'_>,
    note_id: Uuid,
) -> Result<models::Note, sqlx::Error> {
    sqlx::query_as::<_, models::Note>("SELECT * FROM notes WHERE id = ?")
        .bind(note_id)
        .fetch_one(&mut **tx)
        .await
}

/// Applies a board rename and/or viewport persist. Returns `None` when the
/// board does not exist; otherwise `(new_seq, ops, updated board)`.
pub async fn update_board(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    patch: &BoardPatch,
) -> Result<Option<(i64, Value, dto::Board)>, sqlx::Error> {
    if !board_exists(tx, board_id).await? {
        return Ok(None);
    }

    if let Some(name) = patch.name.as_deref() {
        sqlx::query("UPDATE boards SET name = ? WHERE id = ?")
            .bind(name)
            .bind(board_id)
            .execute(&mut **tx)
            .await?;
    }
    if let Some(viewport_state) = &patch.viewport_state {
        sqlx::query("UPDATE boards SET viewport_state = ? WHERE id = ?")
            .bind(viewport_state.clone())
            .bind(board_id)
            .execute(&mut **tx)
            .await?;
    }

    let mut op = serde_json::Map::from_iter([("kind".to_string(), json!("update_board"))]);
    if let Some(name) = patch.name.as_deref() {
        op.insert("name".to_string(), json!(name));
    }
    if let Some(viewport_state) = &patch.viewport_state {
        op.insert(
            "viewport_state".to_string(),
            viewport_state.clone().unwrap_or(Value::Null),
        );
    }
    let ops = json!([op]);
    let seq = events::append_event(tx, board_id, patch.origin(), &ops).await?;

    let board = fetch_board(tx, board_id).await?;
    Ok(Some((seq, ops, board_dto(board))))
}

/// Creates a group. Returns `None` when the board does not exist.
pub async fn create_group(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    new: &NewGroup,
) -> Result<Option<(i64, Value, dto::Group)>, sqlx::Error> {
    if !board_exists(tx, board_id).await? {
        return Ok(None);
    }

    let id = Uuid::now_v7();
    let group = sqlx::query_as::<_, models::Group>(
        "INSERT INTO groups (id, board_id, parent_group_id, name) VALUES (?, ?, ?, ?) RETURNING *",
    )
    .bind(id)
    .bind(board_id)
    .bind(new.parent_group_id)
    .bind(&new.name)
    .fetch_one(&mut **tx)
    .await?;

    let group = group_dto(group);
    let ops = json!([{"kind": "create_group", "group": group}]);
    let seq = events::append_event(tx, board_id, None, &ops).await?;
    Ok(Some((seq, ops, group)))
}

/// Applies a group patch. Returns `None` when no group with `group_id` exists
/// on this board.
pub async fn update_group(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    group_id: Uuid,
    patch: &GroupPatch,
) -> Result<Option<(i64, Value, dto::Group)>, sqlx::Error> {
    // The COALESCE update doubles as the existence check: it matches the row
    // even when every scalar field is absent (parent-only patch).
    let result = sqlx::query(
        "UPDATE groups SET name = COALESCE(?, name), collapsed = COALESCE(?, collapsed), \
            bg_color = CASE WHEN ? IS NULL THEN bg_color ELSE ? END, \
            opacity = COALESCE(?, opacity) \
         WHERE id = ? AND board_id = ?",
    )
    .bind(patch.name.as_deref())
    .bind(patch.collapsed)
    .bind(patch.bg_color.as_ref().map(|value| value.as_deref()))
    .bind(patch.bg_color.as_ref().map(|value| value.as_deref()))
    .bind(patch.opacity)
    .bind(group_id)
    .bind(board_id)
    .execute(&mut **tx)
    .await?;
    if result.rows_affected() == 0 {
        return Ok(None);
    }

    if let Some(parent_group_id) = &patch.parent_group_id {
        sqlx::query("UPDATE groups SET parent_group_id = ? WHERE id = ?")
            .bind(*parent_group_id)
            .bind(group_id)
            .execute(&mut **tx)
            .await?;
    }

    let group = group_dto(fetch_group(tx, group_id).await?);
    let ops = json!([{"kind": "update_group", "group": group}]);
    let seq = events::append_event(tx, board_id, None, &ops).await?;
    Ok(Some((seq, ops, group)))
}

/// Deletes a group (children cascade, member items are ungrouped by the
/// schema). Returns `None` when no group with `group_id` exists on this board.
pub async fn delete_group(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    group_id: Uuid,
) -> Result<Option<(i64, Value)>, sqlx::Error> {
    let result = sqlx::query("DELETE FROM groups WHERE id = ? AND board_id = ?")
        .bind(group_id)
        .bind(board_id)
        .execute(&mut **tx)
        .await?;
    if result.rows_affected() == 0 {
        return Ok(None);
    }

    let ops = json!([{"kind": "delete_group", "id": group_id}]);
    let seq = events::append_event(tx, board_id, None, &ops).await?;
    Ok(Some((seq, ops)))
}

/// Creates a note. Returns `None` when the board does not exist.
pub async fn create_note(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    new: &NewNote,
) -> Result<Option<(i64, Value, dto::Note)>, sqlx::Error> {
    if !board_exists(tx, board_id).await? {
        return Ok(None);
    }

    let id = Uuid::now_v7();
    let z_index = match new.z_index {
        Some(z_index) => z_index,
        None => super::item_service::next_shared_z(tx, board_id).await?,
    };
    let note = sqlx::query_as::<_, models::Note>(
        "INSERT INTO notes (id, board_id, x, y, width, height, rotation, z_index, content_json, bg_color, opacity) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 1.0)) RETURNING *",
    )
    .bind(id)
    .bind(board_id)
    .bind(new.x)
    .bind(new.y)
    .bind(new.width)
    .bind(new.height)
    .bind(new.rotation)
    .bind(z_index)
    .bind(&new.content_json)
    .bind(new.bg_color.as_deref())
    .bind(new.opacity)
    .fetch_one(&mut **tx)
    .await?;

    let note = note_dto(note);
    let ops = json!([{"kind": "create_note", "note": note}]);
    let seq = events::append_event(tx, board_id, None, &ops).await?;
    Ok(Some((seq, ops, note)))
}

/// Applies a note patch. Returns `None` when no note with `note_id` exists on
/// this board.
pub async fn update_note(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    note_id: Uuid,
    patch: &NotePatch,
) -> Result<Option<(i64, Value, dto::Note)>, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE notes SET \
             x = COALESCE(?, x), y = COALESCE(?, y), \
             width = COALESCE(?, width), height = COALESCE(?, height), \
             rotation = COALESCE(?, rotation), z_index = COALESCE(?, z_index), \
             content_json = COALESCE(?, content_json), opacity = COALESCE(?, opacity) \
         WHERE id = ? AND board_id = ?",
    )
    .bind(patch.x)
    .bind(patch.y)
    .bind(patch.width)
    .bind(patch.height)
    .bind(patch.rotation)
    .bind(patch.z_index)
    .bind(patch.content_json.clone())
    .bind(patch.opacity)
    .bind(note_id)
    .bind(board_id)
    .execute(&mut **tx)
    .await?;
    if result.rows_affected() == 0 {
        return Ok(None);
    }

    if let Some(bg_color) = &patch.bg_color {
        sqlx::query("UPDATE notes SET bg_color = ? WHERE id = ?")
            .bind(bg_color.clone())
            .bind(note_id)
            .execute(&mut **tx)
            .await?;
    }

    let note = note_dto(fetch_note(tx, note_id).await?);
    let ops = json!([{"kind": "update_note", "note": note}]);
    let seq = events::append_event(tx, board_id, None, &ops).await?;
    Ok(Some((seq, ops, note)))
}

/// Deletes a note. Returns `None` when no note with `note_id` exists on this
/// board.
pub async fn delete_note(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    note_id: Uuid,
) -> Result<Option<(i64, Value)>, sqlx::Error> {
    let result = sqlx::query("DELETE FROM notes WHERE id = ? AND board_id = ?")
        .bind(note_id)
        .bind(board_id)
        .execute(&mut **tx)
        .await?;
    if result.rows_affected() == 0 {
        return Ok(None);
    }

    let ops = json!([{"kind": "delete_note", "id": note_id}]);
    let seq = events::append_event(tx, board_id, None, &ops).await?;
    Ok(Some((seq, ops)))
}
