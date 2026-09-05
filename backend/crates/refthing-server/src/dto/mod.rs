//! Wire DTOs for the REST/WS API. Distinct from `refthing_core::models` (the
//! DB rows): timestamps are i64 epoch-ms, and `Item.metadata` carries the
//! merged `item_metadata` JSON payload.

pub mod ops;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// `item_type` starts with the struct name on purpose: it mirrors
/// `refthing_core::models::Item` and serializes as `type`.
#[allow(clippy::struct_field_names)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: Uuid,
    pub board_id: Uuid,
    /// Plain `String`, never an enum: Phase 11 item types must deserialize
    /// without a code change.
    #[serde(rename = "type")]
    pub item_type: String,
    pub blob_hash: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Degrees, clockwise.
    pub rotation: f64,
    pub z_index: i64,
    pub group_id: Option<Uuid>,
    /// Merged `item_metadata.json` payload; `{}` when the row is absent.
    pub metadata: serde_json::Value,
    /// Epoch milliseconds.
    pub created_at: i64,
    /// Epoch milliseconds.
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Board {
    pub id: Uuid,
    pub name: String,
    /// Monotonic event-log sequence; clients pass it as `base_seq`/`since`.
    pub seq: i64,
    pub viewport_state: Option<serde_json::Value>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoardSummary {
    pub id: Uuid,
    pub name: String,
    pub item_count: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub id: Uuid,
    pub board_id: Uuid,
    pub parent_group_id: Option<Uuid>,
    pub name: String,
    pub collapsed: bool,
    pub bg_color: Option<String>,
    pub opacity: f64,
    pub created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Note {
    pub id: Uuid,
    pub board_id: Uuid,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub content_json: serde_json::Value,
    pub bg_color: Option<String>,
    pub opacity: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tag {
    pub id: Uuid,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobInfo {
    /// 64-char lowercase hex SHA-256; also the `/blob/{hash}/...` URL key.
    pub hash: String,
    pub original_filename: Option<String>,
    pub mime_type: String,
    pub byte_size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub created_at: i64,
}

/// Single hydration payload for `GET /api/boards/{id}`: everything the canvas
/// needs to render without follow-up requests.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoardSnapshot {
    pub board: Board,
    /// Current board seq at snapshot time; the WS `since` cursor starts here.
    pub seq: i64,
    /// Paint order (ascending `z_index`).
    pub items: Vec<Item>,
    pub groups: Vec<Group>,
    pub notes: Vec<Note>,
    pub tags: Vec<Tag>,
    /// `item_id` → `tag_ids`.
    pub item_tags: HashMap<Uuid, Vec<Uuid>>,
    pub blobs: Vec<BlobInfo>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn round_trip<T>(value: &T)
    where
        T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug,
    {
        let json = serde_json::to_string(value).expect("serialize");
        let parsed: T = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(*value, parsed);
    }

    #[test]
    fn item_round_trip_and_type_rename() {
        let item = Item {
            id: Uuid::now_v7(),
            board_id: Uuid::now_v7(),
            item_type: "image".to_string(),
            blob_hash: Some("ab".repeat(32)),
            x: 1.5,
            y: -2.0,
            width: 800.0,
            height: 600.0,
            rotation: 15.0,
            z_index: 3,
            group_id: Some(Uuid::now_v7()),
            metadata: json!({"kind": "image", "phash": "a1b2"}),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_001,
        };
        let json = serde_json::to_value(&item).expect("serialize");
        assert!(json.get("type").is_some(), "item_type serializes as `type`");
        assert!(json.get("item_type").is_none());
        round_trip(&item);
    }

    #[test]
    fn item_without_blob_round_trip() {
        let item = Item {
            id: Uuid::now_v7(),
            board_id: Uuid::now_v7(),
            item_type: "embed".to_string(),
            blob_hash: None,
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            rotation: 0.0,
            z_index: 0,
            group_id: None,
            metadata: json!({}),
            created_at: 0,
            updated_at: 0,
        };
        round_trip(&item);
    }

    #[test]
    fn board_and_summary_round_trip() {
        let board = Board {
            id: Uuid::now_v7(),
            name: "moodboard".to_string(),
            seq: 42,
            viewport_state: Some(json!({"x": 0, "y": 0, "zoom": 1.0})),
            created_at: 1,
            updated_at: 2,
        };
        round_trip(&board);
        round_trip(&BoardSummary {
            id: board.id,
            name: board.name.clone(),
            item_count: 1234,
            updated_at: 2,
        });
    }

    #[test]
    fn group_note_tag_blob_round_trip() {
        round_trip(&Group {
            id: Uuid::now_v7(),
            board_id: Uuid::now_v7(),
            parent_group_id: None,
            name: "cluster".to_string(),
            collapsed: false,
            bg_color: Some("#334455".to_string()),
            opacity: 0.5,
            created_at: 7,
        });
        round_trip(&Note {
            id: Uuid::now_v7(),
            board_id: Uuid::now_v7(),
            x: 10.0,
            y: 20.0,
            width: 200.0,
            height: 100.0,
            content_json: json!({"text": "hello"}),
            bg_color: None,
            opacity: 1.0,
            created_at: 1,
            updated_at: 2,
        });
        round_trip(&Tag {
            id: Uuid::now_v7(),
            name: "Portrait".to_string(),
            color: None,
        });
        round_trip(&BlobInfo {
            hash: "cd".repeat(32),
            original_filename: Some("ref.png".to_string()),
            mime_type: "image/png".to_string(),
            byte_size: 4096,
            width: Some(64),
            height: Some(64),
            created_at: 9,
        });
    }

    #[test]
    fn board_snapshot_round_trip() {
        let item_id = Uuid::now_v7();
        let tag_id = Uuid::now_v7();
        let snapshot = BoardSnapshot {
            board: Board {
                id: Uuid::now_v7(),
                name: "b".to_string(),
                seq: 5,
                viewport_state: None,
                created_at: 1,
                updated_at: 1,
            },
            seq: 5,
            items: vec![],
            groups: vec![],
            notes: vec![],
            tags: vec![],
            item_tags: HashMap::from([(item_id, vec![tag_id])]),
            blobs: vec![],
        };
        round_trip(&snapshot);
    }
}
