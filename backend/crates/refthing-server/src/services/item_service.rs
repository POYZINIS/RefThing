//! Item mutation engine: single-item REST edits and the 1k-op batch path
//! share ONE transaction, ONE seq bump, and ONE event row per call.
//!
//! All SQL here is runtime (`sqlx::query`, never the `query!` macros) for two
//! reasons: the committed `.sqlx` offline cache must not drift, and the core
//! `query_as!` helpers take `&SqlitePool` so they cannot join the caller's
//! transaction.

use refthing_core::db::{boards, items};
use refthing_core::models::Item as CoreItem;
use serde_json::{Value, json};
use sqlx::{SqlitePool, SqliteTransaction};
use uuid::Uuid;

use crate::dto::Item;
use crate::dto::ops::{BatchOp, BatchRequest, BatchResponse, ItemPatch, RejectedOp};
use crate::error::{AppError, AppResult};
use crate::events::append_event;
use crate::events::hub::ServerMsg;
use crate::state::AppState;

/// REST single-item writes carry no echo-suppression token: their event rows
/// and diffs record `origin = NULL` (a server-attributed write).
const NO_CLIENT: &str = "";

/// Rejection reasons surfaced in `BatchResponse.rejected`.
const ITEM_NOT_FOUND: &str = "item_not_found";
const GROUP_NOT_FOUND: &str = "group_not_found";
const TAG_NOT_FOUND: &str = "tag_not_found";

/// Input for [`create_item`]; the route maps its wire body onto this.
#[derive(Debug, Clone)]
pub struct CreateItem {
    pub item_type: String,
    pub blob_hash: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub metadata: Option<Value>,
}

/// Applies a batch of ops against a board.
///
/// Hard rules from the Phase 2 design: `base_seq` must equal the board's
/// current seq (else [`AppError::Conflict`], which the routes render as 409
/// `seq_conflict`); every op is validated then applied inside ONE
/// transaction; the whole batch costs exactly ONE seq bump and ONE
/// `board_events` row; the broadcast diff carries only the ops that actually
/// applied, with `origin = client_id` for echo suppression.
///
/// A batch in which every op is rejected mutates nothing: no seq bump, no
/// event row, and the (unchanged) current seq is returned.
pub async fn apply_batch(
    state: &AppState,
    board_id: Uuid,
    req: BatchRequest,
) -> AppResult<BatchResponse> {
    let mut tx = state.pools.write.begin().await?;
    let current_seq = board_seq(&mut tx, board_id).await?;
    if req.base_seq != current_seq {
        return Err(AppError::Conflict(format!(
            "base_seq {} is stale; board is at seq {current_seq}",
            req.base_seq
        )));
    }

    let mut applied = Vec::new();
    let mut rejected = Vec::new();
    let mut applied_ops = Vec::new();
    for op in &req.ops {
        match apply_op(&mut tx, board_id, op).await? {
            Ok(()) => {
                applied.push(op.op_id());
                applied_ops.push(op.clone());
            }
            Err(reason) => rejected.push(RejectedOp {
                op_id: op.op_id(),
                reason,
            }),
        }
    }

    if req.atomic && !rejected.is_empty() {
        tx.rollback().await?;
        return Err(AppError::BadRequest(format!(
            "command rejected: {}",
            rejected[0].reason
        )));
    }
    if applied_ops.is_empty() {
        tx.rollback().await?;
        return Ok(BatchResponse {
            seq: current_seq,
            applied,
            rejected,
        });
    }

    // Recovery must replay only committed operations, exactly like live diffs.
    let ops_json = serde_json::to_value(&applied_ops).map_err(json_codec_error)?;
    let origin = (!req.client_id.is_empty()).then_some(req.client_id.as_str());
    let seq = append_event(&mut tx, board_id, origin, &ops_json).await?;
    tx.commit().await?;

    state.hub.broadcast(
        board_id,
        ServerMsg::Diff {
            board_id,
            seq,
            origin: origin.map(str::to_string),
            ops: applied_ops,
        },
    );

    Ok(BatchResponse {
        seq,
        applied,
        rejected,
    })
}

/// Creates a single item: geometry validation, `z_index` on top of the stack,
/// one event row carrying the full item (see [`broadcast_gap`] for why), and
/// a 201-shaped `(seq, item)` result.
pub async fn create_item(
    state: &AppState,
    board_id: Uuid,
    new: CreateItem,
) -> AppResult<(i64, Item)> {
    if !(new.x.is_finite() && new.y.is_finite() && new.width.is_finite() && new.height.is_finite())
    {
        return Err(AppError::BadRequest("non-finite geometry".to_string()));
    }
    if new.width <= 0.0 || new.height <= 0.0 {
        return Err(AppError::BadRequest(
            "width/height must be positive".to_string(),
        ));
    }
    if let Some(hash) = &new.blob_hash {
        let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM blobs WHERE hash = ?")
            .bind(hash)
            .fetch_optional(&state.pools.read)
            .await?;
        if exists.is_none() {
            return Err(AppError::BadRequest(format!("unknown blob_hash {hash}")));
        }
    }

    let id = Uuid::now_v7();
    let mut tx = state.pools.write.begin().await?;
    board_seq(&mut tx, board_id).await?; // 404 on an unknown board
    let z_index = next_z_index(&mut tx, board_id).await?;
    let row = sqlx::query_as::<_, CoreItem>(
        "INSERT INTO items \
             (id, board_id, type, blob_id, x, y, width, height, rotation, z_index, group_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL) RETURNING *",
    )
    .bind(id)
    .bind(board_id)
    .bind(&new.item_type)
    .bind(&new.blob_hash)
    .bind(new.x)
    .bind(new.y)
    .bind(new.width)
    .bind(new.height)
    .bind(z_index)
    .fetch_one(&mut *tx)
    .await?;

    let metadata = if let Some(value) = new.metadata {
        upsert_metadata(&mut tx, id, &value).await?;
        value
    } else {
        json!({})
    };

    let item = to_dto(row, metadata);
    let ops = create_event_ops(&item)?;
    let seq = append_event(&mut tx, board_id, None, &ops).await?;
    tx.commit().await?;

    broadcast_gap(state, board_id, seq);
    Ok((seq, item))
}

/// Single-item PATCH riding the batch machinery (`base_seq = None` means
/// "whatever the board is at now"). Rejections map back to HTTP errors.
pub async fn patch_item(
    state: &AppState,
    board_id: Uuid,
    item_id: Uuid,
    base_seq: Option<i64>,
    patch: ItemPatch,
) -> AppResult<(i64, Item)> {
    let op_id = Uuid::now_v7();
    let response = apply_single(
        state,
        board_id,
        base_seq,
        BatchOp::Update {
            op_id,
            item_id,
            fields: patch,
        },
    )
    .await?;
    let item = item_dto(state, item_id).await?;
    Ok((response.seq, item))
}

/// Single-item DELETE riding the batch machinery; returns the new board seq.
pub async fn delete_item(state: &AppState, board_id: Uuid, item_id: Uuid) -> AppResult<i64> {
    let op_id = Uuid::now_v7();
    let response = apply_single(
        state,
        board_id,
        None,
        BatchOp::Delete {
            op_id,
            item_ids: vec![item_id],
        },
    )
    .await?;
    Ok(response.seq)
}

/// Fetches an item with its merged `item_metadata` payload (`{}` default).
pub async fn item_dto(state: &AppState, item_id: Uuid) -> AppResult<Item> {
    let row = items::get(&state.pools.read, item_id)
        .await?
        .ok_or(AppError::NotFound("item"))?;
    let metadata = metadata_of(&state.pools.read, item_id).await?;
    Ok(to_dto(row, metadata))
}

/// Runs one op through [`apply_batch`] and converts a rejection into the
/// matching HTTP error.
async fn apply_single(
    state: &AppState,
    board_id: Uuid,
    base_seq: Option<i64>,
    op: BatchOp,
) -> AppResult<BatchResponse> {
    let base_seq = match base_seq {
        Some(seq) => seq,
        None => current_seq(state, board_id).await?,
    };
    let response = apply_batch(
        state,
        board_id,
        BatchRequest {
            atomic: false,
            base_seq,
            client_id: NO_CLIENT.to_string(),
            ops: vec![op],
        },
    )
    .await?;
    if let Some(rejected) = response.rejected.first() {
        return Err(rejection_error(&rejected.reason));
    }
    Ok(response)
}

/// Applies one op inside the batch transaction. `Ok(Err(reason))` rejects the
/// op (the batch continues); `Err(_)` aborts the whole batch. Every op
/// validates all referenced rows BEFORE mutating, so a rejected op leaves no
/// partial writes behind.
#[allow(clippy::too_many_lines)]
async fn apply_op(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    op: &BatchOp,
) -> AppResult<Result<(), String>> {
    match op {
        BatchOp::Move {
            item_ids, dx, dy, ..
        } => {
            if !dx.is_finite() || !dy.is_finite() {
                return Ok(Err("invalid_geometry".to_string()));
            }
            if !items_exist(tx, board_id, item_ids).await? {
                return Ok(Err(ITEM_NOT_FOUND.to_string()));
            }
            for id in item_ids {
                sqlx::query("UPDATE items SET x = x + ?, y = y + ? WHERE id = ?")
                    .bind(dx)
                    .bind(dy)
                    .bind(id)
                    .execute(&mut **tx)
                    .await?;
            }
            Ok(Ok(()))
        }
        BatchOp::Update {
            item_id, fields, ..
        } => apply_update(tx, board_id, *item_id, fields).await,
        BatchOp::Delete { item_ids, .. } => {
            if !items_exist(tx, board_id, item_ids).await? {
                return Ok(Err(ITEM_NOT_FOUND.to_string()));
            }
            for id in item_ids {
                sqlx::query("DELETE FROM items WHERE id = ?")
                    .bind(id)
                    .execute(&mut **tx)
                    .await?;
            }
            Ok(Ok(()))
        }
        BatchOp::SetGroup {
            item_ids, group_id, ..
        } => {
            if !items_exist(tx, board_id, item_ids).await? {
                return Ok(Err(ITEM_NOT_FOUND.to_string()));
            }
            if let Some(group_id) = group_id
                && !group_exists(tx, board_id, *group_id).await?
            {
                return Ok(Err(GROUP_NOT_FOUND.to_string()));
            }
            for id in item_ids {
                sqlx::query("UPDATE items SET group_id = ? WHERE id = ?")
                    .bind(group_id)
                    .bind(id)
                    .execute(&mut **tx)
                    .await?;
            }
            Ok(Ok(()))
        }
        BatchOp::SetZ { order, .. } => {
            if !items_exist(tx, board_id, order).await? {
                return Ok(Err(ITEM_NOT_FOUND.to_string()));
            }
            for (index, id) in order.iter().enumerate() {
                let z_index = i64::try_from(index)
                    .map_err(|error| AppError::BadRequest(format!("z order too long: {error}")))?;
                sqlx::query("UPDATE items SET z_index = ? WHERE id = ?")
                    .bind(z_index)
                    .bind(id)
                    .execute(&mut **tx)
                    .await?;
            }
            Ok(Ok(()))
        }
        BatchOp::RestoreItem { item, tag_ids, .. } => {
            restore_item(tx, board_id, item, tag_ids).await
        }
        BatchOp::PutNote { note, .. } => put_note(tx, board_id, note).await,
        BatchOp::DeleteNotes { note_ids, .. } => {
            for id in note_ids {
                let exists: Option<i64> =
                    sqlx::query_scalar("SELECT 1 FROM notes WHERE id = ? AND board_id = ?")
                        .bind(id)
                        .bind(board_id)
                        .fetch_optional(&mut **tx)
                        .await?;
                if exists.is_none() {
                    return Ok(Err("note_not_found".to_string()));
                }
            }
            for id in note_ids {
                sqlx::query("DELETE FROM notes WHERE id = ? AND board_id = ?")
                    .bind(id)
                    .bind(board_id)
                    .execute(&mut **tx)
                    .await?;
            }
            Ok(Ok(()))
        }
        BatchOp::RestoreGroup { group, .. } => restore_group(tx, board_id, group).await,
        BatchOp::SetGroupLocked {
            group_id, locked, ..
        } => {
            let updated = sqlx::query("UPDATE groups SET locked = ? WHERE id = ? AND board_id = ?")
                .bind(locked)
                .bind(group_id)
                .bind(board_id)
                .execute(&mut **tx)
                .await?;
            if updated.rows_affected() == 0 {
                return Ok(Err(GROUP_NOT_FOUND.to_string()));
            }
            Ok(Ok(()))
        }
        BatchOp::RemoveGroup { group_id, .. } => {
            if !group_exists(tx, board_id, *group_id).await? {
                return Ok(Err(GROUP_NOT_FOUND.to_string()));
            }
            let occupied: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM items WHERE group_id = ?) OR EXISTS(SELECT 1 FROM groups WHERE parent_group_id = ?)")
                .bind(group_id).bind(group_id).fetch_one(&mut **tx).await?;
            if occupied != 0 {
                return Ok(Err("group_not_empty".to_string()));
            }
            sqlx::query("DELETE FROM groups WHERE id = ? AND board_id = ?")
                .bind(group_id)
                .bind(board_id)
                .execute(&mut **tx)
                .await?;
            Ok(Ok(()))
        }
    }
}

/// Applies an [`ItemPatch`]: transform fields land in one UPDATE, `group_id`
/// (Some only — clearing rides the `set_group` op), tag links via
/// `item_tags`, and `metadata` as an `item_metadata` upsert.
async fn apply_update(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    item_id: Uuid,
    patch: &ItemPatch,
) -> AppResult<Result<(), String>> {
    let Some(row) = fetch_item_tx(tx, board_id, item_id).await? else {
        return Ok(Err(ITEM_NOT_FOUND.to_string()));
    };

    if !valid_geometry(
        patch.x.unwrap_or(row.x),
        patch.y.unwrap_or(row.y),
        patch.width.unwrap_or(row.width),
        patch.height.unwrap_or(row.height),
        patch.rotation.unwrap_or(row.rotation),
    ) {
        return Ok(Err("invalid_geometry".to_string()));
    }
    // Validate every reference before any write, including geometry and tags.
    if let Some(group_id) = patch.group_id
        && !group_exists(tx, board_id, group_id).await?
    {
        return Ok(Err(GROUP_NOT_FOUND.to_string()));
    }
    for tag_id in &patch.add_tag_ids {
        if !tag_exists(tx, *tag_id).await? {
            return Ok(Err(TAG_NOT_FOUND.to_string()));
        }
    }

    let transform_dirty = patch.x.is_some()
        || patch.y.is_some()
        || patch.width.is_some()
        || patch.height.is_some()
        || patch.rotation.is_some()
        || patch.z_index.is_some();
    if transform_dirty {
        sqlx::query(
            "UPDATE items SET x = ?, y = ?, width = ?, height = ?, rotation = ?, z_index = ? \
             WHERE id = ?",
        )
        .bind(patch.x.unwrap_or(row.x))
        .bind(patch.y.unwrap_or(row.y))
        .bind(patch.width.unwrap_or(row.width))
        .bind(patch.height.unwrap_or(row.height))
        .bind(patch.rotation.unwrap_or(row.rotation))
        .bind(patch.z_index.unwrap_or(row.z_index))
        .bind(item_id)
        .execute(&mut **tx)
        .await?;
    }

    if let Some(group_id) = patch.group_id {
        if !group_exists(tx, board_id, group_id).await? {
            return Ok(Err(GROUP_NOT_FOUND.to_string()));
        }
        sqlx::query("UPDATE items SET group_id = ? WHERE id = ?")
            .bind(group_id)
            .bind(item_id)
            .execute(&mut **tx)
            .await?;
    }

    for tag_id in &patch.add_tag_ids {
        if !tag_exists(tx, *tag_id).await? {
            return Ok(Err(TAG_NOT_FOUND.to_string()));
        }
        sqlx::query("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)")
            .bind(item_id)
            .bind(tag_id)
            .execute(&mut **tx)
            .await?;
    }
    for tag_id in &patch.remove_tag_ids {
        sqlx::query("DELETE FROM item_tags WHERE item_id = ? AND tag_id = ?")
            .bind(item_id)
            .bind(tag_id)
            .execute(&mut **tx)
            .await?;
    }

    if let Some(metadata) = &patch.metadata {
        upsert_metadata(tx, item_id, metadata).await?;
    }
    Ok(Ok(()))
}

/// Maps a core model row + merged metadata JSON onto the wire DTO.
pub(crate) fn to_dto(row: CoreItem, metadata: Value) -> Item {
    Item {
        id: row.id,
        board_id: row.board_id,
        item_type: row.item_type,
        blob_hash: row.blob_id,
        x: row.x,
        y: row.y,
        width: row.width,
        height: row.height,
        rotation: row.rotation,
        z_index: row.z_index,
        group_id: row.group_id,
        metadata,
        created_at: row.created_at.timestamp_millis(),
        updated_at: row.updated_at.timestamp_millis(),
    }
}

/// Next paint-order slot (top of the stack) for a new item on `board_id`.
pub(crate) async fn next_z_index(tx: &mut SqliteTransaction<'_>, board_id: Uuid) -> AppResult<i64> {
    Ok(next_shared_z(tx, board_id).await?)
}

/// Top of the board's ONE paint order. Items and notes interleave on the
/// canvas, so a new node of either kind must land above both.
pub(crate) async fn next_shared_z(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT COALESCE(MAX(z) + 1, 0) FROM (              SELECT z_index AS z FROM items WHERE board_id = ?1              UNION ALL SELECT z_index FROM notes WHERE board_id = ?1)",
    )
    .bind(board_id)
    .fetch_one(&mut **tx)
    .await
}

/// The full-fidelity `create` payload stored in the event row. `BatchOp` has
/// no create variant (frozen wave-A API), so creates/ingests record
/// `[{"kind": "create", "item": …}]` for `/changes` replay.
pub(crate) fn create_event_ops(item: &Item) -> AppResult<Value> {
    let item_json = serde_json::to_value(item).map_err(json_codec_error)?;
    Ok(json!([{"kind": "create", "item": item_json}]))
}

/// See [`create_event_ops`]: a create cannot ride in `ServerMsg::Diff.ops`,
/// so connected clients get an empty-op diff — a pure seq-advance signal that
/// triggers gap recovery via `/changes?since=`.
pub(crate) fn broadcast_gap(state: &AppState, board_id: Uuid, seq: i64) {
    state.hub.broadcast(
        board_id,
        ServerMsg::Diff {
            board_id,
            seq,
            origin: None,
            ops: Vec::new(),
        },
    );
}

/// Maps a serde failure into the error enum (a `json_valid` CHECK and typed
/// DTOs make these unreachable in practice).
pub(crate) fn json_codec_error(error: serde_json::Error) -> AppError {
    AppError::Db(sqlx::Error::Decode(Box::new(error)))
}

/// Current board seq inside the mutation transaction; 404 on unknown board.
async fn board_seq(tx: &mut SqliteTransaction<'_>, board_id: Uuid) -> AppResult<i64> {
    let seq: Option<i64> = sqlx::query_scalar("SELECT seq FROM boards WHERE id = ?")
        .bind(board_id)
        .fetch_optional(&mut **tx)
        .await?;
    seq.ok_or(AppError::NotFound("board"))
}

/// Current board seq from the read pool (resolving `base_seq = None`).
async fn current_seq(state: &AppState, board_id: Uuid) -> AppResult<i64> {
    let board = boards::get(&state.pools.read, board_id)
        .await?
        .ok_or(AppError::NotFound("board"))?;
    Ok(board.seq)
}

async fn fetch_item_tx(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    item_id: Uuid,
) -> AppResult<Option<CoreItem>> {
    let row = sqlx::query_as::<_, CoreItem>("SELECT * FROM items WHERE id = ? AND board_id = ?")
        .bind(item_id)
        .bind(board_id)
        .fetch_optional(&mut **tx)
        .await?;
    Ok(row)
}

async fn items_exist(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    item_ids: &[Uuid],
) -> AppResult<bool> {
    for id in item_ids {
        let exists: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM items WHERE id = ? AND board_id = ?")
                .bind(id)
                .bind(board_id)
                .fetch_optional(&mut **tx)
                .await?;
        if exists.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn group_exists(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    group_id: Uuid,
) -> AppResult<bool> {
    let exists: Option<i64> =
        sqlx::query_scalar("SELECT 1 FROM groups WHERE id = ? AND board_id = ?")
            .bind(group_id)
            .bind(board_id)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(exists.is_some())
}

async fn tag_exists(tx: &mut SqliteTransaction<'_>, tag_id: Uuid) -> AppResult<bool> {
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM tags WHERE id = ?")
        .bind(tag_id)
        .fetch_optional(&mut **tx)
        .await?;
    Ok(exists.is_some())
}

/// Applies `metadata` as a JSON merge patch (RFC 7396): keys it names are set,
/// `null` deletes a key, and every other key is kept. The pyramid job merges
/// its own keys (`dominant_colors`, `phash`) into the same object, so a client
/// edit — which may hold a copy from before the job ran — must never replace
/// the whole payload.
async fn upsert_metadata(
    tx: &mut SqliteTransaction<'_>,
    item_id: Uuid,
    metadata: &Value,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO item_metadata (item_id, json) VALUES (?1, json_patch('{}', ?2)) \
         ON CONFLICT (item_id) DO UPDATE SET json = json_patch(json, ?2)",
    )
    .bind(item_id)
    .bind(metadata.to_string())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn metadata_of(pool: &SqlitePool, item_id: Uuid) -> AppResult<Value> {
    let json_text: Option<String> =
        sqlx::query_scalar("SELECT json FROM item_metadata WHERE item_id = ?")
            .bind(item_id)
            .fetch_optional(pool)
            .await?;
    json_text.map_or_else(
        || Ok(json!({})),
        |text| serde_json::from_str(&text).map_err(json_codec_error),
    )
}

fn rejection_error(reason: &str) -> AppError {
    match reason {
        GROUP_NOT_FOUND => AppError::BadRequest("group not found on this board".to_string()),
        TAG_NOT_FOUND => AppError::BadRequest("tag not found".to_string()),
        _ => AppError::NotFound("item"),
    }
}

fn valid_geometry(x: f64, y: f64, width: f64, height: f64, rotation: f64) -> bool {
    [x, y, width, height, rotation]
        .iter()
        .all(|value| value.is_finite())
        && width > 0.0
        && height > 0.0
}

fn timestamp(millis: i64) -> AppResult<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::from_timestamp_millis(millis)
        .ok_or_else(|| AppError::BadRequest("invalid timestamp".to_string()))
}

async fn restore_item(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    item: &Item,
    tag_ids: &[Uuid],
) -> AppResult<Result<(), String>> {
    if item.board_id != board_id {
        return Ok(Err("wrong_board".to_string()));
    }
    if !valid_geometry(item.x, item.y, item.width, item.height, item.rotation) {
        return Ok(Err("invalid_geometry".to_string()));
    }
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM items WHERE id = ?")
        .bind(item.id)
        .fetch_optional(&mut **tx)
        .await?;
    if exists.is_some() {
        return Ok(Err("item_already_exists".to_string()));
    }
    if let Some(group_id) = item.group_id
        && !group_exists(tx, board_id, group_id).await?
    {
        return Ok(Err(GROUP_NOT_FOUND.to_string()));
    }
    if let Some(hash) = &item.blob_hash {
        let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM blobs WHERE hash = ?")
            .bind(hash)
            .fetch_optional(&mut **tx)
            .await?;
        if exists.is_none() {
            return Ok(Err("blob_not_found".to_string()));
        }
    }
    for tag in tag_ids {
        if !tag_exists(tx, *tag).await? {
            return Ok(Err(TAG_NOT_FOUND.to_string()));
        }
    }
    sqlx::query("INSERT INTO items (id, board_id, type, blob_id, x, y, width, height, rotation, z_index, group_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(item.id).bind(board_id).bind(&item.item_type).bind(&item.blob_hash)
        .bind(item.x).bind(item.y).bind(item.width).bind(item.height).bind(item.rotation)
        .bind(item.z_index).bind(item.group_id).bind(timestamp(item.created_at)?).bind(timestamp(item.updated_at)?)
        .execute(&mut **tx).await?;
    upsert_metadata(tx, item.id, &item.metadata).await?;
    for tag in tag_ids {
        sqlx::query("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)")
            .bind(item.id)
            .bind(tag)
            .execute(&mut **tx)
            .await?;
    }
    Ok(Ok(()))
}

async fn put_note(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    note: &crate::dto::Note,
) -> AppResult<Result<(), String>> {
    if note.board_id != board_id {
        return Ok(Err("wrong_board".to_string()));
    }
    if !valid_geometry(note.x, note.y, note.width, note.height, note.rotation)
        || !note.opacity.is_finite()
        || !(0.0..=1.0).contains(&note.opacity)
    {
        return Ok(Err("invalid_geometry".to_string()));
    }
    let owner: Option<Uuid> = sqlx::query_scalar("SELECT board_id FROM notes WHERE id = ?")
        .bind(note.id)
        .fetch_optional(&mut **tx)
        .await?;
    if owner.is_some_and(|owner| owner != board_id) {
        return Ok(Err("wrong_board".to_string()));
    }
    sqlx::query("INSERT INTO notes (id, board_id, x, y, width, height, rotation, z_index, content_json, bg_color, opacity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height, rotation = excluded.rotation, z_index = excluded.z_index, content_json = excluded.content_json, bg_color = excluded.bg_color, opacity = excluded.opacity")
        .bind(note.id).bind(board_id).bind(note.x).bind(note.y).bind(note.width).bind(note.height)
        .bind(note.rotation).bind(note.z_index).bind(note.content_json.to_string()).bind(&note.bg_color)
        .bind(note.opacity).bind(timestamp(note.created_at)?).bind(timestamp(note.updated_at)?)
        .execute(&mut **tx).await?;
    Ok(Ok(()))
}

async fn restore_group(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    group: &crate::dto::Group,
) -> AppResult<Result<(), String>> {
    if group.board_id != board_id {
        return Ok(Err("wrong_board".to_string()));
    }
    if !group.opacity.is_finite() || !(0.0..=1.0).contains(&group.opacity) {
        return Ok(Err("invalid_opacity".to_string()));
    }
    let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM groups WHERE id = ?")
        .bind(group.id)
        .fetch_optional(&mut **tx)
        .await?;
    if exists.is_some() {
        return Ok(Err("group_already_exists".to_string()));
    }
    if let Some(parent) = group.parent_group_id
        && !group_exists(tx, board_id, parent).await?
    {
        return Ok(Err(GROUP_NOT_FOUND.to_string()));
    }
    sqlx::query("INSERT INTO groups (id, board_id, parent_group_id, name, collapsed, bg_color, opacity, created_at, locked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(group.id).bind(board_id).bind(group.parent_group_id).bind(&group.name).bind(group.collapsed)
        .bind(&group.bg_color).bind(group.opacity).bind(timestamp(group.created_at)?).bind(group.locked)
        .execute(&mut **tx).await?;
    Ok(Ok(()))
}
