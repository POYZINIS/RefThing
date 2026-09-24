//! Serde types for the `manifest.json` document at the root of every
//! `*.refthing.zip` board archive (see `docs/data-model.md`).
//!
//! Version 1 captures one board with everything needed to rebuild it under
//! fresh ids: groups, items (with their `item_metadata` payloads inlined),
//! notes, tags, and the `item_tags` links, plus one descriptor per referenced
//! blob. Blob bytes live next to the manifest as `blobs/<full-hash>` zip
//! entries. Unknown fields are ignored so newer minor versions stay readable.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Required value of [`Manifest::format`]; rejects unrelated zip files early.
pub const MANIFEST_FORMAT: &str = "refthing-board";

/// Highest `format_version` this build knows how to import.
pub const MANIFEST_FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub exported_at: DateTime<Utc>,
    pub board: ManifestBoard,
    pub blobs: Vec<ManifestBlob>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestBoard {
    pub id: Uuid,
    pub name: String,
    pub viewport_state: Option<serde_json::Value>,
    pub groups: Vec<ManifestGroup>,
    pub items: Vec<ManifestItem>,
    pub notes: Vec<ManifestNote>,
    pub tags: Vec<ManifestTag>,
    pub item_tags: Vec<ManifestItemTag>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestGroup {
    pub id: Uuid,
    pub parent_group_id: Option<Uuid>,
    pub name: String,
    pub collapsed: bool,
    pub bg_color: Option<String>,
    pub opacity: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestItem {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub item_type: String,
    pub blob_id: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub z_index: i64,
    pub group_id: Option<Uuid>,
    /// Inlined `item_metadata.json` payload; `null` when the item has none.
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestNote {
    pub id: Uuid,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Defaults keep archives exported before the notes-transform migration
    /// importable (`rotation` 0 / `z_index` 0 = old behavior).
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub z_index: i64,
    pub content_json: serde_json::Value,
    pub bg_color: Option<String>,
    pub opacity: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestTag {
    pub id: Uuid,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestItemTag {
    pub item_id: Uuid,
    pub tag_id: Uuid,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ManifestBlob {
    pub hash: String,
    pub original_filename: Option<String>,
    pub mime_type: String,
    pub byte_size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
}
