//! `.ref` board files (`refthing_core::export::write_ref_file`): a board
//! linked to a file on disk, kept written in the background.
//!
//! Every board is kept in a file: the sync gives a board with none a
//! `<boards folder>/<name>.ref` (the Settings folder, else the app's
//! default — the user's Documents; with neither, as on plain servers and in
//! tests, only boards asked for get files). A new board can name its folder
//! (the app asks when one is created).
//!
//! Every edit is saved to the database the moment it's made (durably — see
//! `refthing_core::db`), so nothing waits on the file. A linked file is
//! rewritten shortly after the board changes: once it has been quiet for
//! [`QUIET`], or every [`MAX_DELAY`] while edits keep coming, and once more
//! when the server shuts down. Each write goes to a temp file, is synced,
//! then replaces the file — a power cut mid-write leaves the previous file
//! whole, and the database still holds everything for the next write.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use refthing_core::db::Pools;
use refthing_core::export::{self, ExportError, Stores};
use serde::Serialize;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::item_types;
use crate::jobs::PyramidPayload;
use crate::state::AppState;

/// A linked file is rewritten once its board has been quiet this long…
const QUIET: Duration = Duration::from_millis(1500);
/// …or at least this often while edits keep coming.
const MAX_DELAY: Duration = Duration::from_secs(10);
/// A failed write (a removed drive, a locked file) is retried this often.
const RETRY: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(500);

/// One `.ref` write at a time: the sync and a route never race on a file.
static WRITES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A board's file, as the UI shows it.
#[derive(Debug, Clone, Serialize)]
pub struct FileStatus {
    pub path: String,
    /// The file holds the board as it is now.
    pub saved: bool,
    /// Why the last write failed, until one succeeds.
    pub error: Option<String>,
}

/// `POST /api/boards:open-file`'s answer.
#[derive(Debug, Clone, Serialize)]
pub struct Opened {
    pub board_id: Uuid,
    pub name: String,
    /// The file was already this board's (it was opened again).
    pub reused: bool,
}

fn stores(data_dir: &Path) -> (PathBuf, PathBuf) {
    (data_dir.join("blobs"), data_dir.join("deriv"))
}

fn export_error(error: ExportError) -> AppError {
    match error {
        ExportError::BoardNotFound(_) => AppError::NotFound("board"),
        ExportError::InvalidArchive(_)
        | ExportError::UnsupportedVersion(_)
        | ExportError::BlobMissing(_)
        | ExportError::BlobIntegrity { .. }
        | ExportError::Zip(_)
        | ExportError::Json(_) => {
            AppError::BadRequest(format!("can't open this board file: {error}"))
        }
        ExportError::Io(error) => AppError::Io(error),
        other => AppError::Io(std::io::Error::other(other.to_string())),
    }
}

/// Everything a board file holds that can change: its event sequence, its
/// row (name, view), and how many of its previews are ready.
async fn change_token(pool: &SqlitePool, board_id: Uuid) -> Result<Option<String>, sqlx::Error> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT b.seq || '|' || b.updated_at || '|' || ( \
             SELECT COUNT(*) FROM blob_derivatives d \
             WHERE d.status = 'ready' AND d.blob_hash IN ( \
                 SELECT i.blob_id FROM items i WHERE i.board_id = b.id AND i.blob_id IS NOT NULL)) \
         FROM boards b WHERE b.id = ?",
    )
    .bind(board_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(token,)| token))
}

/// A path as the link keeps it: absolute, ending in `.ref`.
fn normalize(path: &str) -> AppResult<PathBuf> {
    let mut path = PathBuf::from(path.trim());
    if !path.is_absolute() {
        return Err(AppError::BadRequest(
            "a board file needs a full path".into(),
        ));
    }
    let is_ref = path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("ref"));
    if !is_ref {
        let mut name = path.file_name().unwrap_or_default().to_os_string();
        name.push(".ref");
        path.set_file_name(name);
    }
    Ok(path)
}

/// The file's size and modification time, as recorded after a write.
fn file_stamp(path: &Path) -> Option<(i64, i64)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some((
        i64::try_from(metadata.len()).ok()?,
        i64::try_from(modified.as_millis()).ok()?,
    ))
}

/// Writes board `board_id` to its linked file now.
///
/// # Errors
/// [`AppError::NotFound`] when the board has no file; the write's error
/// otherwise (also recorded on the link, and retried by the sync).
pub async fn write_now(pools: &Pools, data_dir: &Path, board_id: Uuid) -> AppResult<FileStatus> {
    let _one_at_a_time = WRITES.lock().await;
    let (path,): (String,) = sqlx::query_as("SELECT path FROM board_files WHERE board_id = ?")
        .bind(board_id)
        .fetch_optional(&pools.read)
        .await?
        .ok_or(AppError::NotFound("board file"))?;
    // Taken before the snapshot: an edit landing during the write leaves the
    // token behind, so it's written next time.
    let token = change_token(&pools.read, board_id).await?;
    let (blobs, derivatives) = stores(data_dir);
    let target = PathBuf::from(&path);
    let written = export::write_ref_file(
        pools,
        Stores {
            blobs: &blobs,
            derivatives: &derivatives,
        },
        board_id,
        &target,
    )
    .await;
    match written {
        Ok(()) => {
            let stamp = file_stamp(&target);
            sqlx::query(
                "UPDATE board_files SET written_token = ?, error = NULL, \
                 written_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), \
                 written_size = ?, written_mtime_ms = ? WHERE board_id = ?",
            )
            .bind(&token)
            .bind(stamp.map(|(size, _)| size))
            .bind(stamp.map(|(_, mtime)| mtime))
            .bind(board_id)
            .execute(&pools.write)
            .await?;
            Ok(FileStatus {
                path,
                saved: true,
                error: None,
            })
        }
        Err(error) => {
            let message = error.to_string();
            tracing::warn!(%board_id, path, %message, "board file write failed");
            sqlx::query("UPDATE board_files SET error = ? WHERE board_id = ?")
                .bind(&message)
                .bind(board_id)
                .execute(&pools.write)
                .await?;
            Err(export_error(error))
        }
    }
}

/// The board's file, if it has one.
///
/// # Errors
/// Database errors.
pub async fn status(pools: &Pools, board_id: Uuid) -> AppResult<Option<FileStatus>> {
    let row: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT path, written_token, error FROM board_files WHERE board_id = ?")
            .bind(board_id)
            .fetch_optional(&pools.read)
            .await?;
    let Some((path, written, error)) = row else {
        return Ok(None);
    };
    let token = change_token(&pools.read, board_id).await?;
    Ok(Some(FileStatus {
        path,
        saved: written.is_some() && written == token,
        error,
    }))
}

/// Links board `board_id` to the file at `path` (taking the file from any
/// board it was linked to) and writes it now.
///
/// # Errors
/// [`AppError::BadRequest`] for a path that isn't absolute; the write's
/// error otherwise.
pub async fn link(
    pools: &Pools,
    data_dir: &Path,
    board_id: Uuid,
    path: &str,
) -> AppResult<FileStatus> {
    let path = normalize(path)?;
    let path_text = path.to_string_lossy().into_owned();
    let previous: Option<(String,)> =
        sqlx::query_as("SELECT path FROM board_files WHERE board_id = ?")
            .bind(board_id)
            .fetch_optional(&pools.read)
            .await?;
    let mut tx = pools.write.begin().await?;
    let exists: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM boards WHERE id = ?")
        .bind(board_id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound("board"));
    }
    sqlx::query("DELETE FROM board_files WHERE path = ? COLLATE NOCASE OR board_id = ?")
        .bind(&path_text)
        .bind(board_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO board_files (board_id, path) VALUES (?, ?)")
        .bind(board_id)
        .bind(&path_text)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let status = write_now(pools, data_dir, board_id).await?;
    // Moved: the new file is whole, so the old one goes.
    if let Some((old,)) = previous
        && !old.eq_ignore_ascii_case(&path_text)
    {
        std::fs::remove_file(&old).ok();
    }
    Ok(status)
}

/// Where new boards' files go: the Settings choice, else the app's default
/// (`AppConfig::boards_dir`). `None`: boards get files only when asked.
///
/// # Errors
/// Database errors.
pub async fn boards_folder(
    pool: &SqlitePool,
    default: Option<&Path>,
) -> AppResult<Option<PathBuf>> {
    let chosen: Option<(String,)> =
        sqlx::query_as("SELECT value FROM app_settings WHERE key = 'boards_folder'")
            .fetch_optional(pool)
            .await?;
    Ok(chosen
        .map(|(value,)| PathBuf::from(value))
        .or_else(|| default.map(Path::to_path_buf)))
}

/// A board name as a file name (Windows' forbidden characters out).
#[must_use]
pub fn file_name_for(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches('.');
    if cleaned.is_empty() {
        "Board".to_string()
    } else {
        cleaned.to_string()
    }
}

/// A free `<folder>/<name>.ref` — `<name> (2).ref` and on when taken, on
/// disk or by another board.
async fn free_path(pool: &SqlitePool, folder: &Path, name: &str) -> AppResult<PathBuf> {
    let base = file_name_for(name);
    for attempt in 1..10_000 {
        let file = if attempt == 1 {
            format!("{base}.ref")
        } else {
            format!("{base} ({attempt}).ref")
        };
        let path = folder.join(file);
        let taken: Option<(i64,)> =
            sqlx::query_as("SELECT 1 FROM board_files WHERE path = ? COLLATE NOCASE")
                .bind(path.to_string_lossy().as_ref())
                .fetch_optional(pool)
                .await?;
        if taken.is_none() && !path.exists() {
            return Ok(path);
        }
    }
    Err(AppError::Conflict(format!(
        "no free file name for {base} in {}",
        folder.display()
    )))
}

/// Keeps board `board_id` in a new file named after it in `folder` (moving
/// it there if it had one elsewhere), written now.
///
/// # Errors
/// [`AppError::BadRequest`] for a folder that isn't a full path; the
/// write's error otherwise.
pub async fn link_in_folder(
    pools: &Pools,
    data_dir: &Path,
    board_id: Uuid,
    folder: &Path,
) -> AppResult<FileStatus> {
    if !folder.is_absolute() {
        return Err(AppError::BadRequest("a folder needs a full path".into()));
    }
    let name = board_name(&pools.read, board_id).await?;
    let path = free_path(&pools.read, folder, &name).await?;
    link(pools, data_dir, board_id, &path.to_string_lossy()).await
}

/// Settings → Board files: new boards go to `folder` from now on, and the
/// files in the previous folder move with it.
///
/// # Errors
/// [`AppError::BadRequest`] for a folder that isn't a full path; I/O and
/// database errors otherwise. A file that fails to move stays linked where
/// it was (and the failure is logged).
pub async fn set_boards_folder(
    pools: &Pools,
    data_dir: &Path,
    default: Option<&Path>,
    folder: &str,
) -> AppResult<PathBuf> {
    let folder = PathBuf::from(folder.trim());
    if !folder.is_absolute() {
        return Err(AppError::BadRequest("a folder needs a full path".into()));
    }
    std::fs::create_dir_all(&folder)?;
    let previous = boards_folder(&pools.read, default).await?;
    sqlx::query(
        "INSERT INTO app_settings (key, value) VALUES ('boards_folder', ?) \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(folder.to_string_lossy().as_ref())
    .execute(&pools.write)
    .await?;
    let Some(previous) = previous else {
        return Ok(folder);
    };
    let same = |a: &Path, b: &Path| {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    };
    if same(&previous, &folder) {
        return Ok(folder);
    }
    let links: Vec<(Uuid, String)> = sqlx::query_as("SELECT board_id, path FROM board_files")
        .fetch_all(&pools.read)
        .await?;
    for (board_id, path) in links {
        let in_previous = Path::new(&path)
            .parent()
            .is_some_and(|parent| same(parent, &previous));
        if in_previous && let Err(error) = link_in_folder(pools, data_dir, board_id, &folder).await
        {
            tracing::warn!(%board_id, %error, "board file not moved to the new folder");
        }
    }
    Ok(folder)
}

/// Stops keeping the board's file (the file itself stays as it is).
///
/// # Errors
/// Database errors.
pub async fn unlink(pools: &Pools, board_id: Uuid) -> AppResult<()> {
    sqlx::query("DELETE FROM board_files WHERE board_id = ?")
        .bind(board_id)
        .execute(&pools.write)
        .await?;
    Ok(())
}

/// Opens the `.ref` file at `path`: the board it already is (when it's
/// linked and nothing else has changed it since), otherwise a new board
/// from it, linked to it from now on.
///
/// # Errors
/// [`AppError::BadRequest`] when it isn't a board file `RefThing` can read;
/// I/O and database errors otherwise.
pub async fn open(state: &AppState, path: &str) -> AppResult<Opened> {
    let path = normalize(path)?;
    let path_text = path.to_string_lossy().into_owned();
    if !path.is_file() {
        return Err(AppError::NotFound("board file"));
    }
    let linked: Option<(Uuid, Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT board_id, written_size, written_mtime_ms FROM board_files \
         WHERE path = ? COLLATE NOCASE",
    )
    .bind(&path_text)
    .fetch_optional(&state.pools.read)
    .await?;
    if let Some((board_id, size, mtime)) = linked
        && let Some(stamp) = file_stamp(&path)
        && size == Some(stamp.0)
        && mtime == Some(stamp.1)
    {
        return Ok(Opened {
            board_id,
            name: board_name(&state.pools.read, board_id).await?,
            reused: true,
        });
    }

    let board_id = import(state, &path).await?;
    // The file holds exactly this board: linked, and already saved.
    let stamp = file_stamp(&path);
    let token = change_token(&state.pools.read, board_id).await?;
    let mut tx = state.pools.write.begin().await?;
    sqlx::query("DELETE FROM board_files WHERE path = ? COLLATE NOCASE")
        .bind(&path_text)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO board_files (board_id, path, written_token, written_size, written_mtime_ms, written_at) \
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    )
    .bind(board_id)
    .bind(&path_text)
    .bind(&token)
    .bind(stamp.map(|(size, _)| size))
    .bind(stamp.map(|(_, mtime)| mtime))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Opened {
        board_id,
        name: board_name(&state.pools.read, board_id).await?,
        reused: false,
    })
}

/// A `.ref` file as a new board (not linked), with preview jobs queued for
/// anything the file didn't carry previews for.
///
/// # Errors
/// As [`open`].
pub async fn import(state: &AppState, path: &Path) -> AppResult<Uuid> {
    let (blobs, derivatives) = stores(&state.config.data_dir);
    let board_id = export::import_ref_file(
        &state.pools,
        Stores {
            blobs: &blobs,
            derivatives: &derivatives,
        },
        path,
    )
    .await
    .map_err(export_error)?;
    queue_missing_previews(state, board_id).await?;
    Ok(board_id)
}

async fn board_name(pool: &SqlitePool, board_id: Uuid) -> AppResult<String> {
    let (name,): (String,) = sqlx::query_as("SELECT name FROM boards WHERE id = ?")
        .bind(board_id)
        .fetch_one(pool)
        .await?;
    Ok(name)
}

/// Items whose media has no ready preview get the job ingest would have
/// queued (a file written before its previews were done, or a plain backup).
async fn queue_missing_previews(state: &AppState, board_id: Uuid) -> AppResult<()> {
    let rows: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT i.id, b.hash, b.mime_type FROM items i JOIN blobs b ON b.hash = i.blob_id \
         WHERE i.board_id = ? AND NOT EXISTS ( \
             SELECT 1 FROM blob_derivatives d WHERE d.blob_hash = b.hash AND d.status = 'ready')",
    )
    .bind(board_id)
    .fetch_all(&state.pools.read)
    .await?;
    let mut queued = false;
    for (item_id, blob_hash, mime) in rows {
        let Some(job) = item_types::handler_for(&mime).poster_job() else {
            continue;
        };
        let payload = PyramidPayload {
            blob_hash,
            mime,
            item_id,
        };
        let payload = serde_json::to_value(&payload)
            .map_err(|error| AppError::Io(std::io::Error::other(error)))?;
        let mut tx = state.pools.write.begin().await?;
        state.jobs.enqueue_tx(&mut tx, job, payload).await?;
        tx.commit().await?;
        queued = true;
    }
    if queued {
        state.jobs.notify();
    }
    Ok(())
}

// --------------------------------------------------------------------- sync

/// The background writer: keeps every linked file up to date.
#[derive(Clone)]
pub struct RefSync {
    pools: Pools,
    data_dir: PathBuf,
    /// The app's default boards folder (`AppConfig::boards_dir`).
    default_folder: Option<PathBuf>,
}

/// Per board: what the sync has seen since the file was last written.
struct Pending {
    token: String,
    changed: Instant,
    dirty_since: Instant,
    failed: Option<Instant>,
}

impl RefSync {
    /// Starts the writer.
    #[must_use]
    pub fn spawn(pools: Pools, data_dir: PathBuf, default_folder: Option<PathBuf>) -> Self {
        let sync = Self {
            pools,
            data_dir,
            default_folder,
        };
        let background = sync.clone();
        tokio::spawn(async move { background.run().await });
        sync
    }

    async fn run(self) {
        let mut pending: HashMap<Uuid, Pending> = HashMap::new();
        loop {
            tokio::time::sleep(POLL).await;
            if let Err(error) = self.tick(&mut pending).await {
                tracing::warn!(%error, "board file sync check failed");
            }
        }
    }

    async fn tick(&self, pending: &mut HashMap<Uuid, Pending>) -> AppResult<()> {
        self.give_boards_files().await?;
        let links: Vec<(Uuid, Option<String>)> =
            sqlx::query_as("SELECT board_id, written_token FROM board_files")
                .fetch_all(&self.pools.read)
                .await?;
        let now = Instant::now();
        pending.retain(|board_id, _| links.iter().any(|(id, _)| id == board_id));
        for (board_id, written) in links {
            let Some(token) = change_token(&self.pools.read, board_id).await? else {
                continue;
            };
            if written.as_deref() == Some(token.as_str()) {
                pending.remove(&board_id);
                continue;
            }
            let entry = pending.entry(board_id).or_insert_with(|| Pending {
                token: token.clone(),
                changed: now,
                dirty_since: now,
                failed: None,
            });
            if entry.token != token {
                entry.token = token;
                entry.changed = now;
            }
            let due = now.duration_since(entry.changed) >= QUIET
                || now.duration_since(entry.dirty_since) >= MAX_DELAY;
            let backing_off = entry
                .failed
                .is_some_and(|failed| now.duration_since(failed) < RETRY);
            if !due || backing_off {
                continue;
            }
            match write_now(&self.pools, &self.data_dir, board_id).await {
                Ok(_) => {
                    pending.remove(&board_id);
                }
                Err(_) => {
                    entry.failed = Some(Instant::now());
                }
            }
        }
        Ok(())
    }

    /// Every board without a file gets one in the boards folder (a moment
    /// after it's made, so a new board's own choice of folder lands first).
    async fn give_boards_files(&self) -> AppResult<()> {
        let Some(folder) = boards_folder(&self.pools.read, self.default_folder.as_deref()).await?
        else {
            return Ok(());
        };
        let fileless: Vec<(Uuid,)> = sqlx::query_as(
            "SELECT b.id FROM boards b \
             WHERE NOT EXISTS (SELECT 1 FROM board_files f WHERE f.board_id = b.id) \
             AND b.created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 seconds')",
        )
        .fetch_all(&self.pools.read)
        .await?;
        for (board_id,) in fileless {
            if let Err(error) = link_in_folder(&self.pools, &self.data_dir, board_id, &folder).await
            {
                tracing::warn!(%board_id, %error, "board file not created");
            }
        }
        Ok(())
    }

    /// Writes every linked file that's behind, now (at shutdown).
    pub async fn flush(&self) {
        let links: Vec<(Uuid,)> = match sqlx::query_as("SELECT board_id FROM board_files")
            .fetch_all(&self.pools.read)
            .await
        {
            Ok(links) => links,
            Err(error) => {
                tracing::warn!(%error, "board file flush skipped");
                return;
            }
        };
        for (board_id,) in links {
            let behind = match status(&self.pools, board_id).await {
                Ok(Some(status)) => !status.saved,
                _ => false,
            };
            if behind {
                let started = SystemTime::now();
                if write_now(&self.pools, &self.data_dir, board_id)
                    .await
                    .is_ok()
                {
                    tracing::info!(
                        %board_id,
                        ms = started.elapsed().unwrap_or_default().as_millis(),
                        "board file written at shutdown"
                    );
                }
            }
        }
    }
}
