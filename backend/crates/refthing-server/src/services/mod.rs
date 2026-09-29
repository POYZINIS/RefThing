//! Business-logic layer between the route handlers and `refthing_core::db`.
//!
//! Routes stay thin: extract, validate input shape, delegate here, broadcast.
//!
//! Mutation SQL lives here as runtime `sqlx::query` (not the `query!` macros)
//! so the committed `.sqlx` offline cache is never perturbed, and so the
//! statements can ride the caller's transaction — the core CRUD functions all
//! take `&SqlitePool` and cannot join one.

pub mod board_service;
pub mod import_service;
pub mod ingest_service;
pub mod item_service;
pub mod model_service;
pub mod ref_files;
pub mod search;
pub mod snapshots;
pub mod tag_service;
pub mod views;

use chrono::{DateTime, Utc};
use refthing_core::models;
use serde::Deserialize;

use crate::dto;

/// Epoch-milliseconds rendering for the wire DTOs.
#[must_use]
pub fn ms(timestamp: DateTime<Utc>) -> i64 {
    timestamp.timestamp_millis()
}

#[must_use]
pub fn board_dto(board: models::Board) -> dto::Board {
    dto::Board {
        id: board.id,
        name: board.name,
        seq: board.seq,
        viewport_state: board.viewport_state,
        created_at: ms(board.created_at),
        updated_at: ms(board.updated_at),
    }
}

#[must_use]
pub fn summary_dto(summary: refthing_core::db::boards::BoardSummary) -> dto::BoardSummary {
    dto::BoardSummary {
        id: summary.id,
        name: summary.name,
        item_count: summary.item_count,
        updated_at: ms(summary.updated_at),
    }
}

#[must_use]
pub fn item_dto(item: models::Item, metadata: serde_json::Value) -> dto::Item {
    dto::Item {
        id: item.id,
        board_id: item.board_id,
        item_type: item.item_type,
        blob_hash: item.blob_id,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        rotation: item.rotation,
        z_index: item.z_index,
        group_id: item.group_id,
        metadata,
        created_at: ms(item.created_at),
        updated_at: ms(item.updated_at),
    }
}

#[must_use]
pub fn group_dto(group: models::Group) -> dto::Group {
    dto::Group {
        id: group.id,
        board_id: group.board_id,
        parent_group_id: group.parent_group_id,
        name: group.name,
        collapsed: group.collapsed,
        bg_color: group.bg_color,
        opacity: group.opacity,
        created_at: ms(group.created_at),
        locked: group.locked,
    }
}

#[must_use]
pub fn note_dto(note: models::Note) -> dto::Note {
    dto::Note {
        id: note.id,
        board_id: note.board_id,
        x: note.x,
        y: note.y,
        width: note.width,
        height: note.height,
        rotation: note.rotation,
        z_index: note.z_index,
        content_json: note.content_json,
        bg_color: note.bg_color,
        opacity: note.opacity,
        created_at: ms(note.created_at),
        updated_at: ms(note.updated_at),
    }
}

#[must_use]
pub fn tag_dto(tag: models::Tag) -> dto::Tag {
    dto::Tag {
        id: tag.id,
        name: tag.name,
        color: tag.color,
    }
}

/// `serde` maps both a missing field AND an explicit `null` to `None` for
/// `Option<Option<T>>` — this `deserialize_with` keeps the distinction:
/// missing → `None` (leave unchanged), `null` → `Some(None)` (clear),
/// value → `Some(Some(v))`. Requires `#[serde(default)]` on the field.
pub fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}
