use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Board {
    pub id: Uuid,
    pub name: String,
    pub seq: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub viewport_state: Option<serde_json::Value>,
}

/// `item_type` is a plain `String` (not an enum) so Phase 11 item types
/// decode without a schema or code change; per-type payloads live in
/// [`ItemMetadata`].
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Item {
    pub id: Uuid,
    pub board_id: Uuid,
    #[sqlx(rename = "type")]
    pub item_type: String,
    pub blob_id: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub z_index: i64,
    pub group_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Group {
    pub id: Uuid,
    pub board_id: Uuid,
    pub parent_group_id: Option<Uuid>,
    pub name: String,
    pub collapsed: bool,
    pub bg_color: Option<String>,
    pub opacity: f64,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
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
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Tag {
    pub id: Uuid,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Blob {
    pub hash: String,
    pub original_filename: Option<String>,
    pub mime_type: String,
    pub byte_size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub created_at: DateTime<Utc>,
}

/// Per-type item payload stored in `item_metadata.json`. Unknown payloads
/// (written by a newer app version) deserialize into [`ItemMetadata::Unknown`]
/// and round-trip losslessly.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ItemMetadata {
    Image {
        phash: Option<String>,
        dominant_colors: Vec<String>,
    },
    Video {
        duration_ms: u64,
        poster_blob: Option<String>,
    },
    Audio {
        duration_ms: u64,
        waveform_blob: Option<String>,
    },
    Embed {
        url: String,
        og_title: Option<String>,
    },
    #[serde(untagged)]
    Unknown(serde_json::Value),
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn round_trip(metadata: &ItemMetadata) {
        let serialized = serde_json::to_string(metadata).expect("serialize");
        let deserialized: ItemMetadata = serde_json::from_str(&serialized).expect("deserialize");
        assert_eq!(*metadata, deserialized);
    }

    #[test]
    fn image_round_trip() {
        round_trip(&ItemMetadata::Image {
            phash: Some("a1b2c3d4".to_string()),
            dominant_colors: vec!["#ff0000".to_string(), "#00ff00".to_string()],
        });
    }

    #[test]
    fn image_round_trip_without_phash() {
        round_trip(&ItemMetadata::Image {
            phash: None,
            dominant_colors: vec![],
        });
    }

    #[test]
    fn image_serializes_with_snake_case_tag() {
        let metadata = ItemMetadata::Image {
            phash: None,
            dominant_colors: vec![],
        };
        let value = serde_json::to_value(&metadata).expect("serialize");
        assert_eq!(value["kind"], "image");
    }

    #[test]
    fn video_round_trip() {
        round_trip(&ItemMetadata::Video {
            duration_ms: 123_456,
            poster_blob: Some("deadbeef".to_string()),
        });
        round_trip(&ItemMetadata::Video {
            duration_ms: 0,
            poster_blob: None,
        });
    }

    #[test]
    fn audio_round_trip() {
        round_trip(&ItemMetadata::Audio {
            duration_ms: 60_000,
            waveform_blob: Some("cafe".to_string()),
        });
        round_trip(&ItemMetadata::Audio {
            duration_ms: 1,
            waveform_blob: None,
        });
    }

    #[test]
    fn embed_round_trip() {
        round_trip(&ItemMetadata::Embed {
            url: "https://example.com".to_string(),
            og_title: Some("Example".to_string()),
        });
        round_trip(&ItemMetadata::Embed {
            url: "https://example.com".to_string(),
            og_title: None,
        });
    }

    #[test]
    fn unknown_round_trip() {
        round_trip(&ItemMetadata::Unknown(json!({
            "kind": "hologram",
            "vertices": 42
        })));
    }

    #[test]
    fn unrecognized_kind_deserializes_as_unknown() {
        let parsed: ItemMetadata =
            serde_json::from_str(r#"{"kind":"model_3d","polygons":7}"#).expect("deserialize");
        assert_eq!(
            parsed,
            ItemMetadata::Unknown(json!({"kind": "model_3d", "polygons": 7}))
        );
    }
}
