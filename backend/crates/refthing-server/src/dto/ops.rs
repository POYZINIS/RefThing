//! Batch operation protocol shared verbatim by REST (`POST
//! /api/boards/{id}/items/batch`) and client→server WS messages.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// The ONE patch shape — reused by single-item PATCH, batch `update` ops, and
/// WS diffs. Never fork it. Every field absent = unchanged. Clearing an item's
/// group rides the `set_group` op (plain `Option` cannot distinguish "absent"
/// from "set to null" through serde).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ItemPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z_index: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    /// Tag assignment rides inside the patch — no per-tag HTTP calls.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub add_tag_ids: Vec<Uuid>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub remove_tag_ids: Vec<Uuid>,
}

impl ItemPatch {
    /// True when the patch would change nothing.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// One client-ackable unit of a batch. `op_id` is client-generated so the
/// response can report per-op outcomes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BatchOp {
    Move {
        op_id: Uuid,
        item_ids: Vec<Uuid>,
        dx: f64,
        dy: f64,
    },
    Update {
        op_id: Uuid,
        item_id: Uuid,
        fields: ItemPatch,
    },
    Delete {
        op_id: Uuid,
        item_ids: Vec<Uuid>,
    },
    SetGroup {
        op_id: Uuid,
        item_ids: Vec<Uuid>,
        group_id: Option<Uuid>,
    },
    /// Explicit z ordering: batch-assigns `z_index` from list position.
    SetZ {
        op_id: Uuid,
        order: Vec<Uuid>,
    },
    /// Recreate a deleted item with its identity, metadata and tag assignments.
    RestoreItem {
        op_id: Uuid,
        item: super::Item,
        #[serde(default)]
        tag_ids: Vec<Uuid>,
    },
    /// Insert or replace a note on this board, for reversible note commands.
    PutNote {
        op_id: Uuid,
        note: super::Note,
    },
    DeleteNotes {
        op_id: Uuid,
        note_ids: Vec<Uuid>,
    },
    RestoreGroup {
        op_id: Uuid,
        group: super::Group,
    },
    /// Only empty leaf groups can be removed through the command protocol.
    RemoveGroup {
        op_id: Uuid,
        group_id: Uuid,
    },
    /// Lock / unlock a group (§6 RULE 3) — undoable like any other op.
    SetGroupLocked {
        op_id: Uuid,
        group_id: Uuid,
        locked: bool,
    },
    /// Group background: `bg_color` `null` = no background; `opacity` 0–1.
    SetGroupStyle {
        op_id: Uuid,
        group_id: Uuid,
        bg_color: Option<String>,
        opacity: f64,
    },
}

impl BatchOp {
    #[must_use]
    pub fn op_id(&self) -> Uuid {
        match self {
            Self::Move { op_id, .. }
            | Self::Update { op_id, .. }
            | Self::Delete { op_id, .. }
            | Self::SetGroup { op_id, .. }
            | Self::SetZ { op_id, .. }
            | Self::RestoreItem { op_id, .. }
            | Self::PutNote { op_id, .. }
            | Self::DeleteNotes { op_id, .. }
            | Self::RestoreGroup { op_id, .. }
            | Self::RemoveGroup { op_id, .. }
            | Self::SetGroupLocked { op_id, .. }
            | Self::SetGroupStyle { op_id, .. } => *op_id,
        }
    }
}

/// Batch request body (REST) / client→server WS payload. One seq bump per
/// batch, not per op. `base_seq` mismatches get a 409 and the client refetches
/// `/changes?since=` and rebases.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BatchRequest {
    pub base_seq: i64,
    /// Command history requires all-or-nothing application of a gesture.
    #[serde(default)]
    pub atomic: bool,
    /// Echo-suppression token: the sender ignores diffs with its own id.
    pub client_id: String,
    pub ops: Vec<BatchOp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectedOp {
    pub op_id: Uuid,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchResponse {
    /// New board seq after the batch committed.
    pub seq: i64,
    /// `op_id`s that applied.
    pub applied: Vec<Uuid>,
    pub rejected: Vec<RejectedOp>,
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
    fn empty_patch_deserializes_from_empty_object() {
        let patch: ItemPatch = serde_json::from_str("{}").expect("deserialize");
        assert!(patch.is_empty());
        assert_eq!(serde_json::to_string(&patch).expect("serialize"), "{}");
    }

    #[test]
    fn patch_omits_absent_fields() {
        let patch = ItemPatch {
            x: Some(1.0),
            ..ItemPatch::default()
        };
        let json = serde_json::to_value(&patch).expect("serialize");
        assert_eq!(json, json!({"x": 1.0}));
    }

    #[test]
    fn patch_with_tags_round_trip() {
        let add = Uuid::now_v7();
        let remove = Uuid::now_v7();
        round_trip(&ItemPatch {
            add_tag_ids: vec![add],
            remove_tag_ids: vec![remove],
            group_id: Some(Uuid::now_v7()),
            metadata: Some(json!({"kind": "image"})),
            ..ItemPatch::default()
        });
    }

    #[test]
    fn every_op_variant_round_trips() {
        let id = Uuid::now_v7;
        let ops = vec![
            BatchOp::Move {
                op_id: id(),
                item_ids: vec![id(), id()],
                dx: 10.0,
                dy: -5.5,
            },
            BatchOp::Update {
                op_id: id(),
                item_id: id(),
                fields: ItemPatch {
                    rotation: Some(90.0),
                    ..ItemPatch::default()
                },
            },
            BatchOp::Delete {
                op_id: id(),
                item_ids: vec![id()],
            },
            BatchOp::SetGroup {
                op_id: id(),
                item_ids: vec![id()],
                group_id: None,
            },
            BatchOp::SetZ {
                op_id: id(),
                order: vec![id(), id(), id()],
            },
            BatchOp::SetGroupLocked {
                op_id: id(),
                group_id: id(),
                locked: true,
            },
            BatchOp::SetGroupStyle {
                op_id: id(),
                group_id: id(),
                bg_color: Some("#334455".to_string()),
                opacity: 0.5,
            },
        ];
        for op in &ops {
            round_trip(op);
        }
        let json = serde_json::to_value(&ops[0]).expect("serialize");
        assert_eq!(json["kind"], "move");
    }

    #[test]
    fn batch_request_matches_design_wire_shape() {
        let op_id = Uuid::now_v7();
        let item_id = Uuid::now_v7();
        let request: BatchRequest = serde_json::from_value(json!({
            "base_seq": 42,
            "client_id": "c1",
            "ops": [{"op_id": op_id, "kind": "move", "item_ids": [item_id], "dx": 10, "dy": 5}]
        }))
        .expect("deserialize");
        assert_eq!(request.base_seq, 42);
        assert_eq!(request.ops.len(), 1);
        assert_eq!(request.ops[0].op_id(), op_id);
        round_trip(&request);
    }

    #[test]
    fn batch_response_round_trip() {
        round_trip(&BatchResponse {
            seq: 43,
            applied: vec![Uuid::now_v7()],
            rejected: vec![RejectedOp {
                op_id: Uuid::now_v7(),
                reason: "item_not_found".to_string(),
            }],
        });
    }
}
