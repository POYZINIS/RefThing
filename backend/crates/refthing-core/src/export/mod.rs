//! Board export/import archives (`*.refthing.zip`) and `.ref` board files.
//!
//! An archive is a zip containing a deflated `manifest.json` (see
//! [`manifest`]) plus one `blobs/<full-hash>` entry per referenced blob,
//! stored uncompressed because the media formats involved are already
//! compressed. [`export_board`] snapshots one board; [`import_board`]
//! rebuilds it under freshly generated ids, so the same archive can be
//! imported any number of times without id collisions and with blob bytes
//! deduplicated by content hash.
//!
//! A `.ref` file ([`write_ref_file`], [`import_ref_file`]) is the same
//! archive, plus every blob's ready previews (`deriv/<hash>/<file>`, so an
//! opened board shows at once instead of re-processing), behind the fast
//! encryption layer in [`crypt`]. It is written crash-safely: to a temp file
//! beside the target, synced to disk, then renamed over it.

pub mod crypt;
mod manifest;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufReader, BufWriter, Read, Seek, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use sqlx::{Sqlite, Transaction};
use thiserror::Error;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::db::Pools;
use crate::models::{Blob, Board, Group, Item, Note, Tag};

pub use manifest::{
    MANIFEST_FORMAT, MANIFEST_FORMAT_VERSION, Manifest, ManifestBlob, ManifestBoard,
    ManifestDerivative, ManifestGroup, ManifestItem, ManifestItemTag, ManifestNote, ManifestTag,
};

use crypt::CryptFile;

/// Where blob files and their previews live (`<data_dir>/blobs`,
/// `<data_dir>/deriv`).
#[derive(Debug, Clone, Copy)]
pub struct Stores<'a> {
    pub blobs: &'a Path,
    pub derivatives: &'a Path,
}

const MANIFEST_ENTRY_NAME: &str = "manifest.json";

/// Failures of [`export_board`] and [`import_board`].
#[derive(Debug, Error)]
pub enum ExportError {
    #[error("board not found: {0}")]
    BoardNotFound(Uuid),
    #[error("invalid archive: {0}")]
    InvalidArchive(String),
    #[error(
        "unsupported archive format version {0} (this build reads up to {MANIFEST_FORMAT_VERSION})"
    )]
    UnsupportedVersion(u32),
    #[error("archive is missing the blob entry for {0}")]
    BlobMissing(String),
    #[error("blob {hash} failed integrity check: {reason}")]
    BlobIntegrity { hash: String, reason: String },
    #[error("blob {0} is referenced by the board but missing from the blob store")]
    BlobFileMissing(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Zip(#[from] zip::result::ZipError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("database error: {0}")]
    Db(String),
    #[error("background task failed: {0}")]
    Join(#[from] tokio::task::JoinError),
}

impl From<sqlx::Error> for ExportError {
    fn from(error: sqlx::Error) -> Self {
        Self::Db(error.to_string())
    }
}

/// Sharded on-disk location of a blob: `<root>/ab/cd/<full-64-hex-hash>`.
/// `hash` must already be validated by [`canonical_hash`].
fn blob_path(root: &Path, hash: &str) -> PathBuf {
    root.join(&hash[..2]).join(&hash[2..4]).join(hash)
}

fn blob_entry_name(hash: &str) -> String {
    format!("blobs/{hash}")
}

/// A blob's preview folder: `<root>/ab/cd/<hash>/` (pyramid levels, a
/// converted model, a media poster's levels).
fn derivative_dir(root: &Path, hash: &str) -> PathBuf {
    root.join(&hash[..2]).join(&hash[2..4]).join(hash)
}

/// A preview file name is one plain name: no separators, no `..`, nothing
/// hidden — archives come from other machines.
fn safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

/// Lowercases and validates a manifest/blob-store hash (64 hex chars).
fn canonical_hash(hash: &str) -> Result<String, ExportError> {
    let hash = hash.to_ascii_lowercase();
    if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(hash)
    } else {
        Err(ExportError::InvalidArchive(format!(
            "malformed blob hash: {hash:?}"
        )))
    }
}

/// Everything [`build_manifest`] needs, read once from the read pool.
struct BoardSnapshot {
    board: Board,
    groups: Vec<Group>,
    items: Vec<Item>,
    metadata_by_item: HashMap<Uuid, serde_json::Value>,
    notes: Vec<Note>,
    tags: Vec<Tag>,
    item_tag_rows: Vec<(Uuid, Uuid)>,
    blobs: Vec<Blob>,
    derivatives: Vec<ManifestDerivative>,
}

/// Exports one board to `<blob_store_root>/../exports/<name>-<id8>.refthing.zip`
/// and returns the archive path.
///
/// # Errors
/// Returns [`ExportError::BoardNotFound`] for an unknown `board_id`,
/// [`ExportError::BlobFileMissing`] when a referenced blob has no file in the
/// store, and the I/O/zip/database variants for their respective failures.
pub async fn export_board(
    pools: &Pools,
    blob_store_root: &Path,
    board_id: Uuid,
) -> Result<PathBuf, ExportError> {
    let snapshot = fetch_snapshot(pools, board_id).await?;
    for blob in &snapshot.blobs {
        if !blob_path(blob_store_root, &blob.hash).is_file() {
            return Err(ExportError::BlobFileMissing(blob.hash.clone()));
        }
    }

    let manifest = build_manifest(&snapshot);
    let archive_path = export_path(blob_store_root, &snapshot.board);
    let root = blob_store_root.to_path_buf();
    let written_path = archive_path.clone();
    tokio::task::spawn_blocking(move || write_archive(&written_path, &root, &manifest)).await??;
    Ok(archive_path)
}

async fn fetch_snapshot(pools: &Pools, board_id: Uuid) -> Result<BoardSnapshot, ExportError> {
    // One read transaction: a consistent snapshot even while edits land
    // (the `.ref` sync writes boards that are being worked on).
    let mut tx = pools.read.begin().await?;
    let board = sqlx::query_as::<_, Board>("SELECT * FROM boards WHERE id = ?")
        .bind(board_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(ExportError::BoardNotFound(board_id))?;

    let groups = sqlx::query_as::<_, Group>("SELECT * FROM groups WHERE board_id = ? ORDER BY id")
        .bind(board_id)
        .fetch_all(&mut *tx)
        .await?;

    let items =
        sqlx::query_as::<_, Item>("SELECT * FROM items WHERE board_id = ? ORDER BY z_index, id")
            .bind(board_id)
            .fetch_all(&mut *tx)
            .await?;

    let metadata_rows = sqlx::query_as::<_, (Uuid, serde_json::Value)>(
        "SELECT item_id, json FROM item_metadata \
         WHERE item_id IN (SELECT id FROM items WHERE board_id = ?)",
    )
    .bind(board_id)
    .fetch_all(&mut *tx)
    .await?;

    let notes = sqlx::query_as::<_, Note>("SELECT * FROM notes WHERE board_id = ? ORDER BY id")
        .bind(board_id)
        .fetch_all(&mut *tx)
        .await?;

    let tags = sqlx::query_as::<_, Tag>(
        "SELECT t.* FROM tags t \
         JOIN item_tags it ON it.tag_id = t.id \
         JOIN items i ON i.id = it.item_id \
         WHERE i.board_id = ? GROUP BY t.id ORDER BY t.id",
    )
    .bind(board_id)
    .fetch_all(&mut *tx)
    .await?;

    let item_tag_rows = sqlx::query_as::<_, (Uuid, Uuid)>(
        "SELECT it.item_id, it.tag_id FROM item_tags it \
         JOIN items i ON i.id = it.item_id \
         WHERE i.board_id = ? ORDER BY it.item_id, it.tag_id",
    )
    .bind(board_id)
    .fetch_all(&mut *tx)
    .await?;

    // The items' own blobs, and the textures 3D models refer to from their
    // metadata (`model.textures.<channel>` = a blob hash).
    let blobs = sqlx::query_as::<_, Blob>(
        "SELECT b.* FROM blobs b WHERE b.hash IN ( \
             SELECT i.blob_id FROM items i \
             WHERE i.board_id = ?1 AND i.blob_id IS NOT NULL \
             UNION \
             SELECT t.value FROM items i \
             JOIN item_metadata m ON m.item_id = i.id, \
                  json_each(m.json, '$.model.textures') t \
             WHERE i.board_id = ?1 AND t.type = 'text' \
         ) ORDER BY b.hash",
    )
    .bind(board_id)
    .fetch_all(&mut *tx)
    .await?;

    let derivatives = sqlx::query_as::<_, (String, String, i64, i64, i64, String)>(
        "SELECT d.blob_hash, d.level, d.width, d.height, d.byte_size, d.format \
         FROM blob_derivatives d WHERE d.status = 'ready' AND d.blob_hash IN ( \
             SELECT i.blob_id FROM items i \
             WHERE i.board_id = ?1 AND i.blob_id IS NOT NULL \
             UNION \
             SELECT t.value FROM items i \
             JOIN item_metadata m ON m.item_id = i.id, \
                  json_each(m.json, '$.model.textures') t \
             WHERE i.board_id = ?1 AND t.type = 'text' \
         ) ORDER BY d.blob_hash, d.level",
    )
    .bind(board_id)
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .map(
        |(blob_hash, level, width, height, byte_size, format)| ManifestDerivative {
            blob_hash,
            level,
            width,
            height,
            byte_size,
            format,
        },
    )
    .collect();
    tx.commit().await?;

    Ok(BoardSnapshot {
        board,
        groups,
        items,
        metadata_by_item: metadata_rows.into_iter().collect(),
        notes,
        tags,
        item_tag_rows,
        blobs,
        derivatives,
    })
}

fn build_manifest(snapshot: &BoardSnapshot) -> Manifest {
    let snapshot_groups = snapshot
        .groups
        .iter()
        .map(|group| ManifestGroup {
            id: group.id,
            parent_group_id: group.parent_group_id,
            name: group.name.clone(),
            collapsed: group.collapsed,
            bg_color: group.bg_color.clone(),
            opacity: group.opacity,
            locked: group.locked,
        })
        .collect();
    let snapshot_items = snapshot
        .items
        .iter()
        .map(|item| ManifestItem {
            id: item.id,
            item_type: item.item_type.clone(),
            blob_id: item.blob_id.clone(),
            x: item.x,
            y: item.y,
            width: item.width,
            height: item.height,
            rotation: item.rotation,
            z_index: item.z_index,
            group_id: item.group_id,
            metadata: snapshot.metadata_by_item.get(&item.id).cloned(),
        })
        .collect();
    let snapshot_notes = snapshot
        .notes
        .iter()
        .map(|note| ManifestNote {
            id: note.id,
            x: note.x,
            y: note.y,
            width: note.width,
            height: note.height,
            rotation: note.rotation,
            z_index: note.z_index,
            content_json: note.content_json.clone(),
            bg_color: note.bg_color.clone(),
            opacity: note.opacity,
        })
        .collect();
    Manifest {
        format: MANIFEST_FORMAT.to_string(),
        format_version: MANIFEST_FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: chrono::Utc::now(),
        board: ManifestBoard {
            id: snapshot.board.id,
            name: snapshot.board.name.clone(),
            viewport_state: snapshot.board.viewport_state.clone(),
            groups: snapshot_groups,
            items: snapshot_items,
            notes: snapshot_notes,
            tags: snapshot
                .tags
                .iter()
                .map(|tag| ManifestTag {
                    id: tag.id,
                    name: tag.name.clone(),
                    color: tag.color.clone(),
                })
                .collect(),
            item_tags: snapshot
                .item_tag_rows
                .iter()
                .map(|&(item_id, tag_id)| ManifestItemTag { item_id, tag_id })
                .collect(),
        },
        blobs: snapshot
            .blobs
            .iter()
            .map(|blob| ManifestBlob {
                hash: blob.hash.clone(),
                original_filename: blob.original_filename.clone(),
                mime_type: blob.mime_type.clone(),
                byte_size: blob.byte_size,
                width: blob.width,
                height: blob.height,
            })
            .collect(),
        derivatives: snapshot.derivatives.clone(),
    }
}

fn export_path(blob_store_root: &Path, board: &Board) -> PathBuf {
    let sanitized: String = board
        .name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let sanitized = sanitized.trim_matches('-');
    let base = if sanitized.is_empty() {
        "board"
    } else {
        sanitized
    };
    let id = board.id.to_string();
    blob_store_root
        .parent()
        .unwrap_or(blob_store_root)
        .join("exports")
        .join(format!("{base}-{}.refthing.zip", &id[..8]))
}

fn write_archive(
    archive_path: &Path,
    blob_store_root: &Path,
    manifest: &Manifest,
) -> Result<(), ExportError> {
    if let Some(parent) = archive_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file = BufWriter::new(fs::File::create(archive_path)?);
    write_archive_into(file, blob_store_root, None, manifest)?;
    Ok(())
}

/// Writes the archive into `writer`; with `derivatives`, each blob's
/// preview folder rides along. Returns the writer, flushed.
fn write_archive_into<W: Write + Seek>(
    writer: W,
    blob_store_root: &Path,
    derivatives: Option<&Path>,
    manifest: &Manifest,
) -> Result<W, ExportError> {
    let mut zip = ZipWriter::new(writer);

    let manifest_json = serde_json::to_vec_pretty(manifest)?;
    zip.start_file(
        MANIFEST_ENTRY_NAME,
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
    )?;
    zip.write_all(&manifest_json)?;

    let blob_options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for blob in &manifest.blobs {
        let hash = canonical_hash(&blob.hash)?;
        zip.start_file(blob_entry_name(&hash), blob_options)?;
        let mut file = fs::File::open(blob_path(blob_store_root, &hash))?;
        std::io::copy(&mut file, &mut zip)?;
    }

    if let Some(root) = derivatives {
        let hashes: HashSet<&str> = manifest
            .derivatives
            .iter()
            .map(|row| row.blob_hash.as_str())
            .collect();
        for hash in hashes {
            let hash = canonical_hash(hash)?;
            let dir = derivative_dir(root, &hash);
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            let mut names: Vec<String> = entries
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| safe_file_name(name))
                .collect();
            names.sort();
            for name in names {
                zip.start_file(format!("deriv/{hash}/{name}"), blob_options)?;
                let mut file = fs::File::open(dir.join(&name))?;
                std::io::copy(&mut file, &mut zip)?;
            }
        }
    }

    let mut writer = zip.finish()?;
    writer.flush()?;
    Ok(writer)
}

/// Writes board `board_id` to the `.ref` file at `target` — its media, its
/// previews, everything — crash-safely: into a temp file beside it, synced
/// to disk, then renamed over `target`, so a power cut mid-write leaves the
/// previous file whole.
///
/// # Errors
/// As [`export_board`], plus the I/O errors of writing `target`.
pub async fn write_ref_file(
    pools: &Pools,
    stores: Stores<'_>,
    board_id: Uuid,
    target: &Path,
) -> Result<(), ExportError> {
    let snapshot = fetch_snapshot(pools, board_id).await?;
    for blob in &snapshot.blobs {
        if !blob_path(stores.blobs, &blob.hash).is_file() {
            return Err(ExportError::BlobFileMissing(blob.hash.clone()));
        }
    }
    let manifest = build_manifest(&snapshot);
    let blobs = stores.blobs.to_path_buf();
    let derivatives = stores.derivatives.to_path_buf();
    let target = target.to_path_buf();
    tokio::task::spawn_blocking(move || {
        write_ref_blocking(&manifest, &blobs, &derivatives, &target)
    })
    .await??;
    Ok(())
}

fn write_ref_blocking(
    manifest: &Manifest,
    blobs: &Path,
    derivatives: &Path,
    target: &Path,
) -> Result<(), ExportError> {
    let dir = target
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let name = target.file_name().map_or_else(
        || "board".into(),
        |name| name.to_string_lossy().into_owned(),
    );
    let temp = dir.join(format!(".{name}.{}.saving", Uuid::now_v7()));
    let written = (|| -> Result<(), ExportError> {
        let file = fs::File::create(&temp)?;
        let crypt = CryptFile::create(BufWriter::new(file), *Uuid::now_v7().as_bytes())?;
        let crypt = write_archive_into(crypt, blobs, Some(derivatives), manifest)?;
        let file = crypt
            .into_inner()
            .into_inner()
            .map_err(|error| ExportError::Io(error.into_error()))?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    replace_file(&temp, target).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })?;
    Ok(())
}

/// Renames `from` over `to` (replacing it), retrying briefly while another
/// program (a sync client, antivirus) holds `to` open.
fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(error) if attempt < 20 && error.kind() == std::io::ErrorKind::PermissionDenied => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(50 * attempt));
            }
            Err(error) => return Err(error),
        }
    }
}

/// Opens the `.ref` file at `path` as a brand-new board (as
/// [`import_board`]: fresh ids, blobs deduplicated), bringing its previews
/// into the preview store so the board shows at once.
///
/// # Errors
/// [`ExportError::InvalidArchive`] when `path` isn't a `.ref` file (or is
/// from a newer version), and as [`import_board`] otherwise.
pub async fn import_ref_file(
    pools: &Pools,
    stores: Stores<'_>,
    path: &Path,
) -> Result<Uuid, ExportError> {
    let blobs = stores.blobs.to_path_buf();
    let derivatives = stores.derivatives.to_path_buf();
    let path = path.to_path_buf();
    let manifest = tokio::task::spawn_blocking(move || {
        let file = BufReader::new(fs::File::open(&path)?);
        let crypt = CryptFile::open(file).map_err(|error| {
            if error.kind() == std::io::ErrorKind::InvalidData {
                ExportError::InvalidArchive(error.to_string())
            } else {
                ExportError::Io(error)
            }
        })?;
        let mut archive = ZipArchive::new(BufReader::new(crypt))?;
        let manifest = stage_from(&mut archive, &blobs)?;
        stage_derivatives(&mut archive, &manifest, &derivatives)?;
        Ok::<_, ExportError>(manifest)
    })
    .await??;
    validate_references(&manifest)?;
    insert_board(pools, &manifest).await
}

/// Copies the archive's preview files into the preview store (missing ones
/// only), each through a synced temp file.
fn stage_derivatives<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    manifest: &Manifest,
    root: &Path,
) -> Result<(), ExportError> {
    let known: HashSet<String> = manifest
        .blobs
        .iter()
        .map(|blob| blob.hash.to_ascii_lowercase())
        .collect();
    let names: Vec<String> = archive
        .file_names()
        .filter(|name| name.starts_with("deriv/"))
        .map(str::to_string)
        .collect();
    for name in names {
        let mut parts = name["deriv/".len()..].splitn(2, '/');
        let (Some(hash), Some(file_name)) = (parts.next(), parts.next()) else {
            continue;
        };
        let hash = canonical_hash(hash)?;
        if !known.contains(&hash) || !safe_file_name(file_name) {
            return Err(ExportError::InvalidArchive(format!(
                "unexpected preview entry {name:?}"
            )));
        }
        let dir = derivative_dir(root, &hash);
        let target = dir.join(file_name);
        if target.is_file() {
            continue;
        }
        fs::create_dir_all(&dir)?;
        let temp = dir.join(format!(".{file_name}.{}.part", Uuid::now_v7()));
        let copied = (|| -> Result<(), ExportError> {
            let mut entry = archive.by_name(&name)?;
            let mut out = fs::File::create(&temp)?;
            std::io::copy(&mut entry, &mut out)?;
            out.sync_all()?;
            Ok(())
        })();
        if let Err(error) = copied {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        if fs::rename(&temp, &target).is_err() {
            // Placed meanwhile (same content-addressed name): keep that one.
            let _ = fs::remove_file(&temp);
        }
    }
    Ok(())
}

/// Imports a `*.refthing.zip` archive as a brand-new board and returns its id.
///
/// Every id in the archive is regenerated through a remap table (tags are
/// merged by name, case-insensitively), so importing the same archive twice
/// yields two independent boards. Blob integrity is verified against the
/// manifest SHA-256 before the database is touched; blob files already in the
/// store are not copied again. All rows land in a single write transaction.
///
/// # Errors
/// Returns [`ExportError::UnsupportedVersion`] for archives newer than
/// [`MANIFEST_FORMAT_VERSION`], [`ExportError::InvalidArchive`] for structurally
/// broken manifests, [`ExportError::BlobMissing`]/[`ExportError::BlobIntegrity`]
/// for missing or corrupt blob entries, and the I/O/zip/database variants for
/// their respective failures.
pub async fn import_board(
    pools: &Pools,
    blob_store_root: &Path,
    archive_path: &Path,
) -> Result<Uuid, ExportError> {
    let root = blob_store_root.to_path_buf();
    let path = archive_path.to_path_buf();
    let manifest = tokio::task::spawn_blocking(move || stage_archive(&path, &root)).await??;
    validate_references(&manifest)?;
    insert_board(pools, &manifest).await
}

/// Reads the manifest, verifies every blob entry against its stated SHA-256,
/// and stages blobs missing from the store — all before any database write.
fn stage_archive(archive_path: &Path, blob_store_root: &Path) -> Result<Manifest, ExportError> {
    let mut archive = ZipArchive::new(BufReader::new(fs::File::open(archive_path)?))?;
    stage_from(&mut archive, blob_store_root)
}

fn stage_from<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    blob_store_root: &Path,
) -> Result<Manifest, ExportError> {
    let manifest = read_manifest(archive)?;
    validate_manifest_header(&manifest)?;

    for blob in &manifest.blobs {
        verify_blob_entry(archive, blob)?;
    }
    for blob in &manifest.blobs {
        let hash = canonical_hash(&blob.hash)?;
        let entry = archive
            .by_name(&blob_entry_name(&hash))
            .map_err(|_| ExportError::BlobMissing(hash.clone()))?;
        stage_blob(blob_store_root, &hash, entry)?;
    }

    Ok(manifest)
}

fn read_manifest<R: Read + Seek>(archive: &mut ZipArchive<R>) -> Result<Manifest, ExportError> {
    let entry = archive
        .by_name(MANIFEST_ENTRY_NAME)
        .map_err(|_| ExportError::InvalidArchive("archive has no manifest.json".to_string()))?;
    Ok(serde_json::from_reader(entry)?)
}

fn validate_manifest_header(manifest: &Manifest) -> Result<(), ExportError> {
    if manifest.format != MANIFEST_FORMAT {
        return Err(ExportError::InvalidArchive(format!(
            "unexpected format {:?}, expected {MANIFEST_FORMAT:?}",
            manifest.format
        )));
    }
    if manifest.format_version > MANIFEST_FORMAT_VERSION {
        return Err(ExportError::UnsupportedVersion(manifest.format_version));
    }
    Ok(())
}

fn verify_blob_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    blob: &ManifestBlob,
) -> Result<(), ExportError> {
    let hash = canonical_hash(&blob.hash)?;
    let expected_size = u64::try_from(blob.byte_size).map_err(|_| ExportError::BlobIntegrity {
        hash: hash.clone(),
        reason: format!("negative byte_size {}", blob.byte_size),
    })?;
    let mut entry = archive
        .by_name(&blob_entry_name(&hash))
        .map_err(|_| ExportError::BlobMissing(hash.clone()))?;
    let mut hasher = Sha256::new();
    let copied = std::io::copy(&mut entry, &mut hasher)?;
    let actual = format!("{:x}", hasher.finalize());
    if actual != hash {
        return Err(ExportError::BlobIntegrity {
            hash,
            reason: format!("sha256 mismatch: entry content hashes to {actual}"),
        });
    }
    if copied != expected_size {
        return Err(ExportError::BlobIntegrity {
            hash,
            reason: format!(
                "byte_size mismatch: entry holds {copied} bytes, manifest says {expected_size}"
            ),
        });
    }
    Ok(())
}

/// Copies a blob into the sharded store via a temp file + atomic rename.
/// Returns early when the content-addressed target already exists (dedup).
fn stage_blob(root: &Path, hash: &str, mut reader: impl Read) -> Result<(), ExportError> {
    let target = blob_path(root, hash);
    if target.is_file() {
        return Ok(());
    }
    let tmp_dir = root.join("tmp");
    fs::create_dir_all(&tmp_dir)?;
    let tmp_path = tmp_dir.join(format!("{}.part", Uuid::now_v7()));
    let copy = fs::File::create(&tmp_path).and_then(|mut out| {
        std::io::copy(&mut reader, &mut out)?;
        out.sync_all()
    });
    if let Err(error) = copy {
        let _ = fs::remove_file(&tmp_path);
        return Err(error.into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(&tmp_path, &target) {
        Ok(()) => Ok(()),
        // Windows rename fails when the target exists; a concurrent same-bytes
        // placement is a dedup hit, not an error.
        Err(_) if target.is_file() => {
            let _ = fs::remove_file(&tmp_path);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&tmp_path);
            Err(error.into())
        }
    }
}

/// Cross-reference checks that produce clean errors instead of FK violations.
fn validate_references(manifest: &Manifest) -> Result<(), ExportError> {
    let board = &manifest.board;

    let blob_hashes: HashSet<String> = manifest
        .blobs
        .iter()
        .map(|blob| blob.hash.to_ascii_lowercase())
        .collect();
    let group_ids: HashSet<Uuid> = board.groups.iter().map(|group| group.id).collect();
    let item_ids: HashSet<Uuid> = board.items.iter().map(|item| item.id).collect();
    let tag_ids: HashSet<Uuid> = board.tags.iter().map(|tag| tag.id).collect();

    for group in &board.groups {
        if let Some(parent) = group.parent_group_id
            && !group_ids.contains(&parent)
        {
            return Err(ExportError::InvalidArchive(format!(
                "group {} has a dangling parent_group_id {parent}",
                group.id
            )));
        }
    }
    for item in &board.items {
        if let Some(blob_id) = &item.blob_id
            && !blob_hashes.contains(&blob_id.to_ascii_lowercase())
        {
            return Err(ExportError::InvalidArchive(format!(
                "item {} references blob {blob_id} which is not in the archive",
                item.id
            )));
        }
        if let Some(group_id) = item.group_id
            && !group_ids.contains(&group_id)
        {
            return Err(ExportError::InvalidArchive(format!(
                "item {} references unknown group {group_id}",
                item.id
            )));
        }
    }
    for link in &board.item_tags {
        if !item_ids.contains(&link.item_id) {
            return Err(ExportError::InvalidArchive(format!(
                "item_tags references unknown item {}",
                link.item_id
            )));
        }
        if !tag_ids.contains(&link.tag_id) {
            return Err(ExportError::InvalidArchive(format!(
                "item_tags references unknown tag {}",
                link.tag_id
            )));
        }
    }
    Ok(())
}

/// Rebuilds the board from `manifest` under fresh ids in one write-pool
/// transaction, inserting in FK order.
async fn insert_board(pools: &Pools, manifest: &Manifest) -> Result<Uuid, ExportError> {
    let mut tx = pools.write.begin().await?;

    let board_id = Uuid::now_v7();
    sqlx::query("INSERT INTO boards (id, name, viewport_state) VALUES (?, ?, ?)")
        .bind(board_id)
        .bind(&manifest.board.name)
        .bind(manifest.board.viewport_state.clone())
        .execute(&mut *tx)
        .await?;

    let group_ids = insert_groups(&mut tx, board_id, &manifest.board.groups).await?;
    insert_blobs(&mut tx, &manifest.blobs).await?;
    insert_derivatives(&mut tx, manifest).await?;
    let item_ids = insert_items(&mut tx, board_id, &group_ids, &manifest.board.items).await?;
    insert_notes(&mut tx, board_id, &manifest.board.notes).await?;
    let tag_ids = insert_tags(&mut tx, &manifest.board.tags).await?;
    insert_item_tags(&mut tx, &manifest.board.item_tags, &item_ids, &tag_ids).await?;

    tx.commit().await?;
    Ok(board_id)
}

/// Inserts groups parents-first (the FK on `parent_group_id` is immediate).
async fn insert_groups(
    tx: &mut Transaction<'_, Sqlite>,
    board_id: Uuid,
    groups: &[ManifestGroup],
) -> Result<HashMap<Uuid, Uuid>, ExportError> {
    let mut remap = HashMap::with_capacity(groups.len());
    let mut remaining: Vec<&ManifestGroup> = groups.iter().collect();
    while let Some(position) = remaining.iter().position(|group| {
        group
            .parent_group_id
            .is_none_or(|parent| remap.contains_key(&parent))
    }) {
        let group = remaining.remove(position);
        let new_id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO groups (id, board_id, parent_group_id, name, collapsed, bg_color, opacity, locked) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(new_id)
        .bind(board_id)
        .bind(group.parent_group_id.map(|parent| remap[&parent]))
        .bind(&group.name)
        .bind(group.collapsed)
        .bind(&group.bg_color)
        .bind(group.opacity)
        .bind(group.locked)
        .execute(&mut **tx)
        .await?;
        remap.insert(group.id, new_id);
    }
    if !remaining.is_empty() {
        return Err(ExportError::InvalidArchive(
            "groups contain a parent cycle".to_string(),
        ));
    }
    Ok(remap)
}

async fn insert_blobs(
    tx: &mut Transaction<'_, Sqlite>,
    blobs: &[ManifestBlob],
) -> Result<(), ExportError> {
    for blob in blobs {
        // OR IGNORE: the blob may already be known from an earlier import.
        sqlx::query(
            "INSERT OR IGNORE INTO blobs (hash, original_filename, mime_type, byte_size, width, height) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(canonical_hash(&blob.hash)?)
        .bind(&blob.original_filename)
        .bind(&blob.mime_type)
        .bind(blob.byte_size)
        .bind(blob.width)
        .bind(blob.height)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// Ready preview rows for the blobs, where the store has no row yet (a blob
/// already known here keeps its own). A generated level whose file didn't
/// come across is left out — the preview job makes it instead.
async fn insert_derivatives(
    tx: &mut Transaction<'_, Sqlite>,
    manifest: &Manifest,
) -> Result<(), ExportError> {
    let known: HashSet<String> = manifest
        .blobs
        .iter()
        .map(|blob| blob.hash.to_ascii_lowercase())
        .collect();
    for row in &manifest.derivatives {
        let hash = canonical_hash(&row.blob_hash)?;
        if !known.contains(&hash) {
            continue;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO blob_derivatives \
             (blob_hash, level, width, height, byte_size, format, status) \
             VALUES (?, ?, ?, ?, ?, ?, 'ready')",
        )
        .bind(&hash)
        .bind(&row.level)
        .bind(row.width)
        .bind(row.height)
        .bind(row.byte_size)
        .bind(&row.format)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn insert_items(
    tx: &mut Transaction<'_, Sqlite>,
    board_id: Uuid,
    group_ids: &HashMap<Uuid, Uuid>,
    items: &[ManifestItem],
) -> Result<HashMap<Uuid, Uuid>, ExportError> {
    let mut remap = HashMap::with_capacity(items.len());
    for item in items {
        let group_id = item
            .group_id
            .map(|id| {
                group_ids.get(&id).copied().ok_or_else(|| {
                    ExportError::InvalidArchive(format!(
                        "item {} references unknown group {id}",
                        item.id
                    ))
                })
            })
            .transpose()?;
        let new_id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO items \
             (id, board_id, type, blob_id, x, y, width, height, rotation, z_index, group_id) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(new_id)
        .bind(board_id)
        .bind(&item.item_type)
        .bind(item.blob_id.as_deref().map(str::to_ascii_lowercase))
        .bind(item.x)
        .bind(item.y)
        .bind(item.width)
        .bind(item.height)
        .bind(item.rotation)
        .bind(item.z_index)
        .bind(group_id)
        .execute(&mut **tx)
        .await?;
        if let Some(metadata) = &item.metadata {
            sqlx::query("INSERT INTO item_metadata (item_id, json) VALUES (?, ?)")
                .bind(new_id)
                .bind(metadata)
                .execute(&mut **tx)
                .await?;
        }
        remap.insert(item.id, new_id);
    }
    Ok(remap)
}

async fn insert_notes(
    tx: &mut Transaction<'_, Sqlite>,
    board_id: Uuid,
    notes: &[ManifestNote],
) -> Result<(), ExportError> {
    for note in notes {
        sqlx::query(
            "INSERT INTO notes (id, board_id, x, y, width, height, rotation, z_index, content_json, bg_color, opacity) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(Uuid::now_v7())
        .bind(board_id)
        .bind(note.x)
        .bind(note.y)
        .bind(note.width)
        .bind(note.height)
        .bind(note.rotation)
        .bind(note.z_index)
        .bind(&note.content_json)
        .bind(&note.bg_color)
        .bind(note.opacity)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// Merges tags by name (`tags.name` is `UNIQUE COLLATE NOCASE`): an existing
/// tag with the same name is reused, otherwise a fresh id is inserted.
async fn insert_tags(
    tx: &mut Transaction<'_, Sqlite>,
    tags: &[ManifestTag],
) -> Result<HashMap<Uuid, Uuid>, ExportError> {
    let mut remap = HashMap::with_capacity(tags.len());
    for tag in tags {
        let existing = sqlx::query_as::<_, (Uuid,)>("SELECT id FROM tags WHERE name = ?")
            .bind(&tag.name)
            .fetch_optional(&mut **tx)
            .await?;
        let new_id = if let Some((id,)) = existing {
            id
        } else {
            let id = Uuid::now_v7();
            sqlx::query("INSERT INTO tags (id, name, color) VALUES (?, ?, ?)")
                .bind(id)
                .bind(&tag.name)
                .bind(&tag.color)
                .execute(&mut **tx)
                .await?;
            id
        };
        remap.insert(tag.id, new_id);
    }
    Ok(remap)
}

async fn insert_item_tags(
    tx: &mut Transaction<'_, Sqlite>,
    item_tags: &[ManifestItemTag],
    item_ids: &HashMap<Uuid, Uuid>,
    tag_ids: &HashMap<Uuid, Uuid>,
) -> Result<(), ExportError> {
    for link in item_tags {
        let item_id = item_ids.get(&link.item_id).ok_or_else(|| {
            ExportError::InvalidArchive(format!(
                "item_tags references unknown item {}",
                link.item_id
            ))
        })?;
        let tag_id = tag_ids.get(&link.tag_id).ok_or_else(|| {
            ExportError::InvalidArchive(format!("item_tags references unknown tag {}", link.tag_id))
        })?;
        // OR IGNORE: two archive tags merged into one existing tag (case
        // variants) would otherwise collide on the (item_id, tag_id) PK.
        sqlx::query("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)")
            .bind(item_id)
            .bind(tag_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::float_cmp)] // round-trip through SQLite REAL is bit-exact
mod tests {
    use super::*;
    use crate::db;

    const BLOB_A: &[u8] = b"fake png bytes for blob A";
    const BLOB_B: &[u8] = b"fake png bytes for blob B, slightly different";

    async fn test_env() -> (tempfile::TempDir, Pools, PathBuf) {
        let dir = tempfile::tempdir().expect("temp dir");
        let pools = db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        let blob_root = dir.path().join("blobs");
        (dir, pools, blob_root)
    }

    fn sha256_hex(data: &[u8]) -> String {
        format!("{:x}", Sha256::digest(data))
    }

    async fn scalar(pools: &Pools, sql: &str, board_id: Option<Uuid>) -> i64 {
        let query = sqlx::query_as::<_, (i64,)>(sql);
        let query = match board_id {
            Some(id) => query.bind(id),
            None => query,
        };
        query.fetch_one(&pools.read).await.expect("scalar").0
    }

    async fn seed_blobs(pools: &Pools, blob_root: &Path) -> (String, String) {
        let hash_a = sha256_hex(BLOB_A);
        let hash_b = sha256_hex(BLOB_B);
        for (hash, content) in [(&hash_a, BLOB_A), (&hash_b, BLOB_B)] {
            let path = blob_path(blob_root, hash);
            fs::create_dir_all(path.parent().expect("shard dir")).expect("mkdir");
            fs::write(&path, content).expect("write blob");
            sqlx::query(
                "INSERT INTO blobs (hash, original_filename, mime_type, byte_size, width, height) \
                 VALUES (?, ?, 'image/png', ?, 64, 64)",
            )
            .bind(hash)
            .bind(format!("{hash}.png"))
            .bind(i64::try_from(content.len()).expect("len fits"))
            .execute(&pools.write)
            .await
            .expect("insert blob");
        }
        (hash_a, hash_b)
    }

    /// Board + nested groups + two tags; returns the ids items need.
    struct SeedIds {
        board_id: Uuid,
        group_b: Uuid,
        tag_a: Uuid,
        tag_b: Uuid,
    }

    async fn seed_groups_and_tags(pools: &Pools) -> SeedIds {
        let board_id = Uuid::now_v7();
        sqlx::query("INSERT INTO boards (id, name, viewport_state) VALUES (?, 'Test Board', ?)")
            .bind(board_id)
            .bind(serde_json::json!({"x": 10.0, "y": -4.5, "zoom": 1.25}))
            .execute(&pools.write)
            .await
            .expect("insert board");

        let group_a = Uuid::now_v7();
        let group_b = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO groups (id, board_id, name, collapsed) VALUES (?, ?, 'root group', 0)",
        )
        .bind(group_a)
        .bind(board_id)
        .execute(&pools.write)
        .await
        .expect("insert group a");
        sqlx::query(
            "INSERT INTO groups (id, board_id, parent_group_id, name, collapsed, bg_color, opacity) \
             VALUES (?, ?, ?, 'nested', 1, '#334455', 0.75)",
        )
        .bind(group_b)
        .bind(board_id)
        .bind(group_a)
        .execute(&pools.write)
        .await
        .expect("insert group b");

        let tag_a = Uuid::now_v7();
        let tag_b = Uuid::now_v7();
        sqlx::query("INSERT INTO tags (id, name, color) VALUES (?, 'Sunset', '#ff8800')")
            .bind(tag_a)
            .execute(&pools.write)
            .await
            .expect("insert tag a");
        sqlx::query("INSERT INTO tags (id, name) VALUES (?, 'ref')")
            .bind(tag_b)
            .execute(&pools.write)
            .await
            .expect("insert tag b");

        SeedIds {
            board_id,
            group_b,
            tag_a,
            tag_b,
        }
    }

    /// Three items (image w/ blob + metadata in the nested group, blob-less
    /// embed w/ metadata, plain image), one note, three item-tag links.
    async fn seed_items(pools: &Pools, ids: &SeedIds, hash_a: &str, hash_b: &str) {
        let board_id = ids.board_id;
        let item_a = Uuid::now_v7();
        let item_b = Uuid::now_v7();
        let item_c = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO items \
             (id, board_id, type, blob_id, x, y, width, height, rotation, z_index, group_id) \
             VALUES (?, ?, 'image', ?, 10.0, 20.0, 200.0, 100.0, 15.0, 0, ?)",
        )
        .bind(item_a)
        .bind(board_id)
        .bind(hash_a)
        .bind(ids.group_b)
        .execute(&pools.write)
        .await
        .expect("insert item a");
        sqlx::query(
            "INSERT INTO items (id, board_id, type, x, y, width, height, z_index) \
             VALUES (?, ?, 'embed', 0.0, 0.0, 300.0, 200.0, 1)",
        )
        .bind(item_b)
        .bind(board_id)
        .execute(&pools.write)
        .await
        .expect("insert item b");
        sqlx::query(
            "INSERT INTO items (id, board_id, type, blob_id, x, y, width, height, z_index) \
             VALUES (?, ?, 'image', ?, -50.0, 80.0, 64.0, 64.0, 2)",
        )
        .bind(item_c)
        .bind(board_id)
        .bind(hash_b)
        .execute(&pools.write)
        .await
        .expect("insert item c");

        sqlx::query("INSERT INTO item_metadata (item_id, json) VALUES (?, ?)")
            .bind(item_a)
            .bind(serde_json::json!({
                "kind": "image", "phash": "abcd0123", "dominant_colors": ["#ff0000"]
            }))
            .execute(&pools.write)
            .await
            .expect("insert metadata a");
        sqlx::query("INSERT INTO item_metadata (item_id, json) VALUES (?, ?)")
            .bind(item_b)
            .bind(serde_json::json!({
                "kind": "embed", "url": "https://example.com", "og_title": "Example"
            }))
            .execute(&pools.write)
            .await
            .expect("insert metadata b");

        sqlx::query(
            "INSERT INTO notes (id, board_id, x, y, width, height, rotation, z_index, content_json, bg_color, opacity) \
             VALUES (?, ?, 5.0, 6.0, 150.0, 80.0, 12.5, 3, ?, '#ffff00', 0.5)",
        )
        .bind(Uuid::now_v7())
        .bind(board_id)
        .bind(serde_json::json!({"text": "remember this"}))
        .execute(&pools.write)
        .await
        .expect("insert note");

        for (item, tag) in [
            (item_a, ids.tag_a),
            (item_a, ids.tag_b),
            (item_c, ids.tag_b),
        ] {
            sqlx::query("INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?)")
                .bind(item)
                .bind(tag)
                .execute(&pools.write)
                .await
                .expect("insert item_tag");
        }
    }

    /// One board exercising every exported table.
    async fn seed_board(pools: &Pools, blob_root: &Path) -> Uuid {
        let (hash_a, hash_b) = seed_blobs(pools, blob_root).await;
        let ids = seed_groups_and_tags(pools).await;
        seed_items(pools, &ids, &hash_a, &hash_b).await;
        ids.board_id
    }

    async fn fetch_items(pools: &Pools, board_id: Uuid) -> Vec<Item> {
        sqlx::query_as::<_, Item>("SELECT * FROM items WHERE board_id = ? ORDER BY z_index, id")
            .bind(board_id)
            .fetch_all(&pools.read)
            .await
            .expect("fetch items")
    }

    /// Fetches the same id-agnostic projection from both databases and asserts
    /// the rows are identical.
    async fn assert_projection<T>(
        pools_a: &Pools,
        id_a: Uuid,
        pools_b: &Pools,
        id_b: Uuid,
        sql: &str,
    ) where
        T: for<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow>
            + PartialEq
            + std::fmt::Debug
            + Send
            + Unpin,
    {
        let rows_a = sqlx::query_as::<_, T>(sql)
            .bind(id_a)
            .fetch_all(&pools_a.read)
            .await
            .expect("projection a");
        let rows_b = sqlx::query_as::<_, T>(sql)
            .bind(id_b)
            .fetch_all(&pools_b.read)
            .await
            .expect("projection b");
        assert_eq!(rows_a, rows_b);
    }

    async fn assert_items_equal(pools_a: &Pools, id_a: Uuid, pools_b: &Pools, id_b: Uuid) {
        let items_a = fetch_items(pools_a, id_a).await;
        let items_b = fetch_items(pools_b, id_b).await;
        assert_eq!(items_a.len(), items_b.len());
        for (before, after) in items_a.iter().zip(&items_b) {
            assert_ne!(before.id, after.id, "ids must be regenerated");
            assert_eq!(before.item_type, after.item_type);
            assert_eq!(before.blob_id, after.blob_id);
            assert_eq!(before.x, after.x);
            assert_eq!(before.y, after.y);
            assert_eq!(before.width, after.width);
            assert_eq!(before.height, after.height);
            assert_eq!(before.rotation, after.rotation);
            assert_eq!(before.z_index, after.z_index);
        }
    }

    /// Id-agnostic structural comparison of two boards in two databases.
    async fn assert_boards_equal(pools_a: &Pools, id_a: Uuid, pools_b: &Pools, id_b: Uuid) {
        let board_a = sqlx::query_as::<_, Board>("SELECT * FROM boards WHERE id = ?")
            .bind(id_a)
            .fetch_one(&pools_a.read)
            .await
            .expect("board a");
        let board_b = sqlx::query_as::<_, Board>("SELECT * FROM boards WHERE id = ?")
            .bind(id_b)
            .fetch_one(&pools_b.read)
            .await
            .expect("board b");
        assert_eq!(board_a.name, board_b.name);
        assert_eq!(board_a.viewport_state, board_b.viewport_state);

        assert_items_equal(pools_a, id_a, pools_b, id_b).await;

        assert_projection::<(String, Option<String>, bool, Option<String>, f64)>(
            pools_a,
            id_a,
            pools_b,
            id_b,
            "SELECT g.name, p.name, g.collapsed, g.bg_color, g.opacity \
             FROM groups g LEFT JOIN groups p ON p.id = g.parent_group_id \
             WHERE g.board_id = ? ORDER BY g.name",
        )
        .await;

        assert_projection::<(i64, Option<String>)>(
            pools_a,
            id_a,
            pools_b,
            id_b,
            "SELECT i.z_index, g.name FROM items i \
             LEFT JOIN groups g ON g.id = i.group_id WHERE i.board_id = ? ORDER BY i.z_index",
        )
        .await;

        assert_projection::<(i64, serde_json::Value)>(
            pools_a,
            id_a,
            pools_b,
            id_b,
            "SELECT i.z_index, m.json FROM item_metadata m \
             JOIN items i ON i.id = m.item_id WHERE i.board_id = ? ORDER BY i.z_index",
        )
        .await;

        assert_projection::<(f64, f64, f64, f64, serde_json::Value, Option<String>, f64)>(
            pools_a,
            id_a,
            pools_b,
            id_b,
            "SELECT x, y, width, height, content_json, bg_color, opacity \
             FROM notes WHERE board_id = ? ORDER BY id",
        )
        .await;

        assert_projection::<(String, Option<String>)>(
            pools_a,
            id_a,
            pools_b,
            id_b,
            "SELECT DISTINCT t.name, t.color FROM tags t \
             JOIN item_tags it ON it.tag_id = t.id \
             JOIN items i ON i.id = it.item_id WHERE i.board_id = ? ORDER BY t.name",
        )
        .await;

        assert_projection::<(i64, String)>(
            pools_a,
            id_a,
            pools_b,
            id_b,
            "SELECT i.z_index, t.name FROM item_tags it \
             JOIN items i ON i.id = it.item_id JOIN tags t ON t.id = it.tag_id \
             WHERE i.board_id = ? ORDER BY i.z_index, t.name",
        )
        .await;
    }

    fn count_files(dir: &Path) -> usize {
        let mut total = 0;
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    total += count_files(&path);
                } else {
                    total += 1;
                }
            }
        }
        total
    }

    /// Copies a zip entry-by-entry, transforming entry contents via `map`.
    fn map_archive(src: &Path, dst: &Path, map: impl Fn(&str, &[u8]) -> Vec<u8>) {
        let mut archive =
            ZipArchive::new(fs::File::open(src).expect("open archive")).expect("read archive");
        let mut writer = ZipWriter::new(fs::File::create(dst).expect("create archive"));
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).expect("entry");
            if entry.is_dir() {
                continue;
            }
            let name = entry.name().to_string();
            let mut data = Vec::new();
            entry.read_to_end(&mut data).expect("read entry");
            let data = map(&name, &data);
            writer
                .start_file(name, SimpleFileOptions::default())
                .expect("start entry");
            writer.write_all(&data).expect("write entry");
        }
        writer.finish().expect("finish archive");
    }

    #[tokio::test]
    async fn export_import_round_trip() {
        let (_dir_a, pools_a, root_a) = test_env().await;
        let board_id = seed_board(&pools_a, &root_a).await;

        let archive = export_board(&pools_a, &root_a, board_id)
            .await
            .expect("export");
        assert!(archive.is_file());
        assert!(archive.to_string_lossy().ends_with(".refthing.zip"));

        // Import into a fresh database with an empty blob store.
        let (_dir_b, pools_b, root_b) = test_env().await;
        let new_board_id = import_board(&pools_b, &root_b, &archive)
            .await
            .expect("import");
        assert_ne!(board_id, new_board_id);

        assert_boards_equal(&pools_a, board_id, &pools_b, new_board_id).await;

        for (hash, content) in [(sha256_hex(BLOB_A), BLOB_A), (sha256_hex(BLOB_B), BLOB_B)] {
            let bytes = fs::read(blob_path(&root_b, &hash)).expect("imported blob file");
            assert_eq!(bytes, content);
        }
    }

    #[tokio::test]
    async fn ref_file_round_trip_carries_media_previews_and_is_encrypted() {
        let (dir_a, pools_a, root_a) = test_env().await;
        let board_id = seed_board(&pools_a, &root_a).await;
        // A ready preview for blob A, with its file.
        let hash_a = sha256_hex(BLOB_A);
        let deriv_a = dir_a.path().join("deriv");
        fs::create_dir_all(derivative_dir(&deriv_a, &hash_a)).expect("deriv dir");
        fs::write(
            derivative_dir(&deriv_a, &hash_a).join("thumb.webp"),
            b"thumb bytes",
        )
        .expect("thumb");
        sqlx::query(
            "INSERT INTO blob_derivatives (blob_hash, level, width, height, byte_size, format, status)              VALUES (?, 'thumb', 64, 48, 11, 'image/webp', 'ready')",
        )
        .bind(&hash_a)
        .execute(&pools_a.write)
        .await
        .expect("derivative row");

        let target = dir_a.path().join("out").join("My board.ref");
        let stores_a = Stores {
            blobs: &root_a,
            derivatives: &deriv_a,
        };
        write_ref_file(&pools_a, stores_a, board_id, &target)
            .await
            .expect("write");
        let bytes = fs::read(&target).expect("read file");
        assert!(crypt::is_ref(&bytes));
        for needle in [
            &b"manifest.json"[..],
            BLOB_A,
            b"thumb bytes",
            b"refthing-board",
        ] {
            assert!(
                !bytes.windows(needle.len()).any(|window| window == needle),
                "nothing readable in the file"
            );
        }
        // Rewriting leaves no temp files behind and replaces the old file.
        write_ref_file(&pools_a, stores_a, board_id, &target)
            .await
            .expect("rewrite");
        let left: Vec<_> = fs::read_dir(target.parent().unwrap()).unwrap().collect();
        assert_eq!(left.len(), 1, "only the .ref itself");

        let (dir_b, pools_b, root_b) = test_env().await;
        let deriv_b = dir_b.path().join("deriv");
        let stores_b = Stores {
            blobs: &root_b,
            derivatives: &deriv_b,
        };
        let new_board = import_ref_file(&pools_b, stores_b, &target)
            .await
            .expect("open");
        assert_boards_equal(&pools_a, board_id, &pools_b, new_board).await;
        assert_eq!(
            fs::read(derivative_dir(&deriv_b, &hash_a).join("thumb.webp")).expect("preview"),
            b"thumb bytes"
        );
        let (status,): (String,) = sqlx::query_as(
            "SELECT status FROM blob_derivatives WHERE blob_hash = ? AND level = 'thumb'",
        )
        .bind(&hash_a)
        .fetch_one(&pools_b.read)
        .await
        .expect("preview row");
        assert_eq!(status, "ready");

        // Not a .ref file: a clear error, nothing written.
        let plain = dir_a.path().join("plain.ref");
        fs::write(&plain, b"PK not ours").expect("write plain");
        assert!(matches!(
            import_ref_file(&pools_b, stores_b, &plain).await,
            Err(ExportError::InvalidArchive(_))
        ));
    }

    #[tokio::test]
    async fn export_unknown_board_fails() {
        let (_dir, pools, root) = test_env().await;
        let missing = Uuid::now_v7();
        let result = export_board(&pools, &root, missing).await;
        assert!(matches!(result, Err(ExportError::BoardNotFound(id)) if id == missing));
    }

    #[tokio::test]
    async fn double_import_dedups_blobs_and_merges_tags() {
        let (_dir_a, pools_a, root_a) = test_env().await;
        let board_id = seed_board(&pools_a, &root_a).await;
        let archive = export_board(&pools_a, &root_a, board_id)
            .await
            .expect("export");

        let (_dir_b, pools_b, root_b) = test_env().await;
        let first = import_board(&pools_b, &root_b, &archive)
            .await
            .expect("first import");
        let second = import_board(&pools_b, &root_b, &archive)
            .await
            .expect("second import");
        assert_ne!(first, second);

        assert_eq!(
            scalar(&pools_b, "SELECT COUNT(*) FROM boards", None).await,
            2
        );
        assert_eq!(
            scalar(&pools_b, "SELECT COUNT(*) FROM blobs", None).await,
            2
        );
        assert_eq!(
            scalar(&pools_b, "SELECT COUNT(*) FROM tags", None).await,
            2,
            "second import must merge tags by name"
        );
        assert_eq!(
            count_files(&root_b),
            2,
            "blob files must be deduplicated on disk"
        );
        for board in [first, second] {
            assert_eq!(
                scalar(
                    &pools_b,
                    "SELECT COUNT(*) FROM items WHERE board_id = ?",
                    Some(board)
                )
                .await,
                3
            );
            assert_eq!(
                scalar(
                    &pools_b,
                    "SELECT COUNT(*) FROM item_tags it JOIN items i ON i.id = it.item_id \
                     WHERE i.board_id = ?",
                    Some(board)
                )
                .await,
                3
            );
        }
    }

    #[tokio::test]
    async fn corrupt_blob_fails_before_any_db_write() {
        let (_dir_a, pools_a, root_a) = test_env().await;
        let board_id = seed_board(&pools_a, &root_a).await;
        let archive = export_board(&pools_a, &root_a, board_id)
            .await
            .expect("export");

        let corrupted = archive.with_file_name("corrupted.refthing.zip");
        map_archive(&archive, &corrupted, |name, data| {
            if name.starts_with("blobs/") && !data.is_empty() {
                let mut flipped = data.to_vec();
                flipped[0] ^= 0xff;
                flipped
            } else {
                data.to_vec()
            }
        });

        let (_dir_b, pools_b, root_b) = test_env().await;
        let result = import_board(&pools_b, &root_b, &corrupted).await;
        assert!(
            matches!(result, Err(ExportError::BlobIntegrity { .. })),
            "expected BlobIntegrity, got {result:?}"
        );
        assert_eq!(
            scalar(&pools_b, "SELECT COUNT(*) FROM boards", None).await,
            0
        );
        assert_eq!(
            scalar(&pools_b, "SELECT COUNT(*) FROM blobs", None).await,
            0
        );
    }

    #[tokio::test]
    async fn unsupported_format_version_is_rejected() {
        let (_dir_a, pools_a, root_a) = test_env().await;
        let board_id = seed_board(&pools_a, &root_a).await;
        let archive = export_board(&pools_a, &root_a, board_id)
            .await
            .expect("export");

        let bumped = archive.with_file_name("v99.refthing.zip");
        map_archive(&archive, &bumped, |name, data| {
            if name == MANIFEST_ENTRY_NAME {
                let mut manifest: Manifest = serde_json::from_slice(data).expect("manifest");
                manifest.format_version = 99;
                serde_json::to_vec(&manifest).expect("serialize")
            } else {
                data.to_vec()
            }
        });

        let (_dir_b, pools_b, root_b) = test_env().await;
        let result = import_board(&pools_b, &root_b, &bumped).await;
        assert!(
            matches!(result, Err(ExportError::UnsupportedVersion(99))),
            "expected UnsupportedVersion(99), got {result:?}"
        );
        assert_eq!(
            scalar(&pools_b, "SELECT COUNT(*) FROM boards", None).await,
            0
        );
    }

    #[tokio::test]
    async fn foreign_format_is_rejected() {
        let (_dir_a, pools_a, root_a) = test_env().await;
        let board_id = seed_board(&pools_a, &root_a).await;
        let archive = export_board(&pools_a, &root_a, board_id)
            .await
            .expect("export");

        let foreign = archive.with_file_name("foreign.refthing.zip");
        map_archive(&archive, &foreign, |name, data| {
            if name == MANIFEST_ENTRY_NAME {
                let mut manifest: Manifest = serde_json::from_slice(data).expect("manifest");
                manifest.format = "someone-else".to_string();
                serde_json::to_vec(&manifest).expect("serialize")
            } else {
                data.to_vec()
            }
        });

        let (_dir_b, pools_b, root_b) = test_env().await;
        let result = import_board(&pools_b, &root_b, &foreign).await;
        assert!(
            matches!(result, Err(ExportError::InvalidArchive(_))),
            "expected InvalidArchive, got {result:?}"
        );
        assert_eq!(
            scalar(&pools_b, "SELECT COUNT(*) FROM boards", None).await,
            0
        );
    }
}
