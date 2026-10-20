//! Board import: a `PureRef` 2 `.pur`, or a `RefThing` `.ref` file, becomes
//! a new `RefThing` board.
//!
//! Parsing and geometry live in `refthing_core::pureref`; this file commits
//! the result through the SAME paths as an ordinary drop — every image goes
//! through the blob store and `ingest_service::commit_file` (blob row, item
//! row, event row, poster job in one transaction), every note through
//! `board_service::create_note` — so an imported board is indistinguishable
//! from one built by hand. Items land back to front, so each takes the top of
//! the shared paint order in `PureRef`'s stacking order.

use std::collections::HashMap;

use axum::extract::Multipart;
use axum::http::StatusCode;
use refthing_core::CoreError;
use refthing_core::db::boards;
use refthing_core::pureref::{self, ImagePlacement, NotePlacement, Placed};
use serde::Serialize;
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::events::hub::ServerMsg;
use crate::services::board_service::{self, NewNote};
use crate::services::ingest_service::{Landing, commit_file};
use crate::services::ref_files;
use crate::state::AppState;

/// 201 body: the new board and what came across.
#[derive(Debug, Clone, Serialize)]
pub struct ImportResponse {
    pub board_id: Uuid,
    pub name: String,
    pub images: usize,
    pub notes: usize,
    /// Things the file held that `RefThing` could not bring in, in words.
    pub skipped: Vec<String>,
    /// The file was already a board's own: that board, not a new one.
    pub reopened: bool,
}

/// Handles `POST /api/boards:import` (multipart, one `file` part).
pub async fn import_board(state: &AppState, multipart: Multipart) -> AppResult<ImportResponse> {
    let (filename, bytes) = read_upload(multipart).await?;
    if refthing_core::export::crypt::is_ref(&bytes) {
        return import_ref(state, &bytes).await;
    }
    let board = pureref::read_board(&bytes, &state.config.data_dir.join("tmp"))
        .await
        .map_err(|error| match error {
            CoreError::InvalidInput(message) => AppError::BadRequest(message),
            other => AppError::Core(other),
        })?;
    drop(bytes);

    let name = board_name(&filename);
    let board_id = boards::create(&state.pools.write, &name).await?.id;

    // Each embedded image once; instances share the stored blob.
    let mut blobs = HashMap::new();
    for resource in &board.resources {
        let blob = state.blob_store.put(resource.bytes.as_slice()).await?;
        blobs.insert(resource.id, (resource.filename.clone(), blob));
    }

    let (mut images, mut notes) = (0, 0);
    for placed in &board.placed {
        match placed {
            Placed::Image {
                resource,
                placement,
                opacity,
            } => {
                let Some((filename, blob)) = blobs.get(resource) else {
                    continue;
                };
                let landing = landing(placement, *opacity);
                commit_file(state, board_id, Some(filename.clone()), blob, &landing).await?;
                images += 1;
            }
            Placed::Note {
                placement,
                bg_color,
                opacity,
            } => {
                commit_note(state, board_id, placement, bg_color.clone(), *opacity).await?;
                notes += 1;
            }
        }
    }
    if images > 0 {
        state.jobs.notify();
    }

    Ok(ImportResponse {
        board_id,
        name,
        images,
        notes,
        skipped: board.skipped,
        reopened: false,
    })
}

/// An uploaded `.ref` file (dropped on the window, which gives no path to
/// link): the board it already is (its own linked file, dropped back in),
/// else a new board from it, not linked to any file.
async fn import_ref(state: &AppState, bytes: &[u8]) -> AppResult<ImportResponse> {
    if let Some(board_id) = ref_files::board_holding(state, bytes).await? {
        return summary(state, board_id, true).await;
    }
    let tmp = state.config.data_dir.join("tmp");
    tokio::fs::create_dir_all(&tmp).await?;
    let path = tmp.join(format!("{}.ref", Uuid::now_v7()));
    tokio::fs::write(&path, bytes).await?;
    let imported = ref_files::import(state, &path).await;
    let _ = tokio::fs::remove_file(&path).await;
    summary(state, imported?, false).await
}

/// A board's name and counts, as the import answers them.
async fn summary(state: &AppState, board_id: Uuid, reopened: bool) -> AppResult<ImportResponse> {
    let (name, images, notes): (String, i64, i64) = sqlx::query_as(
        "SELECT b.name,                 (SELECT COUNT(*) FROM items i WHERE i.board_id = b.id),                 (SELECT COUNT(*) FROM notes n WHERE n.board_id = b.id)          FROM boards b WHERE b.id = ?",
    )
    .bind(board_id)
    .fetch_one(&state.pools.read)
    .await?;
    Ok(ImportResponse {
        board_id,
        name,
        images: usize::try_from(images).unwrap_or(0),
        notes: usize::try_from(notes).unwrap_or(0),
        skipped: Vec::new(),
        reopened,
    })
}

/// The one uploaded file: its name and bytes.
async fn read_upload(mut multipart: Multipart) -> AppResult<(String, Vec<u8>)> {
    let field = multipart
        .next_field()
        .await
        .map_err(|error| {
            if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
                AppError::TooLarge
            } else {
                AppError::BadRequest(error.to_string())
            }
        })?
        .ok_or_else(|| AppError::BadRequest("no file".to_string()))?;
    let name = field.file_name().unwrap_or("Imported board").to_string();
    let bytes = field
        .bytes()
        .await
        .map_err(|error| AppError::BadRequest(error.to_string()))?;
    Ok((name, bytes.to_vec()))
}

/// An image's frame plus the item metadata `RefThing` keeps crop, mirror and
/// opacity in.
fn landing(placement: &ImagePlacement, opacity: f64) -> Landing {
    let mut metadata = Map::new();
    if let Some((x, y, w, h)) = placement.crop {
        metadata.insert("crop".into(), json!({"x": x, "y": y, "w": w, "h": h}));
    }
    if placement.flip_x {
        metadata.insert("flip_x".into(), Value::Bool(true));
    }
    if opacity < 1.0 {
        metadata.insert("opacity".into(), json!(opacity));
    }
    Landing {
        x: placement.x,
        y: placement.y,
        size: Some((placement.width, placement.height)),
        rotation: placement.rotation,
        metadata: (!metadata.is_empty()).then_some(metadata),
    }
}

async fn commit_note(
    state: &AppState,
    board_id: Uuid,
    placement: &NotePlacement,
    bg_color: Option<String>,
    opacity: f64,
) -> AppResult<()> {
    let note = NewNote {
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
        rotation: placement.rotation,
        z_index: None,
        content_json: json!({"text": placement.text, "scale": placement.scale}),
        bg_color,
        opacity: Some(opacity),
    };
    let mut tx = state.pools.write.begin().await?;
    let created = board_service::create_note(&mut tx, board_id, &note).await?;
    tx.commit().await?;
    if let Some((seq, _, _)) = created {
        state.hub.broadcast(
            board_id,
            ServerMsg::Diff {
                board_id,
                seq,
                origin: None,
                ops: vec![],
            },
        );
    }
    Ok(())
}

/// "Women Board Thing.pur" → "Women Board Thing".
fn board_name(filename: &str) -> String {
    let base = filename.rsplit(['/', '\\']).next().unwrap_or(filename);
    let stem = base
        .strip_suffix(".pur")
        .or_else(|| base.strip_suffix(".PUR"))
        .unwrap_or(base)
        .trim();
    if stem.is_empty() {
        "Imported board".to_string()
    } else {
        stem.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::board_name;

    #[test]
    fn board_names_come_from_the_file() {
        assert_eq!(board_name("Women Board Thing.pur"), "Women Board Thing");
        assert_eq!(board_name("C:\\refs\\TEST.PUR"), "TEST");
        assert_eq!(board_name(".pur"), "Imported board");
    }
}
