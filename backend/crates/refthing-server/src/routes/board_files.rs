//! `.ref` board files (`services::ref_files`). Composed without the JSON
//! API's timeout: writing or opening a big board can take longer than it.
//!
//! | route                              | does                                   |
//! |------------------------------------|----------------------------------------|
//! | `GET    /api/boards/{id}/file`     | the board's linked file and whether it's saved |
//! | `PUT    /api/boards/{id}/file`     | link the board to a path, write it now |
//! | `DELETE /api/boards/{id}/file`     | stop keeping the file (it stays)       |
//! | `POST   /api/boards:open-file`     | open a `.ref` by path (linked)         |
//! | `GET    /api/boards/{id}/download.ref` | the board as a `.ref` download      |
//!
//! The routes that take a path on this machine only answer `RefThing`'s own
//! pages: a request carrying another site's `Origin` is refused, so a web
//! page can't make the app read or write files.

use std::path::PathBuf;

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::stream;
use refthing_core::export::{self, Stores};
use serde::Deserialize;
use tokio::io::AsyncReadExt;
use uuid::Uuid;

use refthing_server::services::ref_files::{self, FileStatus, Opened};

use crate::auth::Principal;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/boards/{id}/file",
            get(get_file).put(put_file).delete(delete_file),
        )
        .route("/api/boards:open-file", post(open_file))
        .route("/api/boards/{id}/download.ref", get(download))
        .route(
            "/api/settings/boards-folder",
            get(get_boards_folder).put(put_boards_folder),
        )
}

#[derive(Debug, serde::Serialize)]
struct BoardsFolder {
    /// Where new boards' files go; `null` when boards get files only when
    /// asked (no default and no choice).
    folder: Option<String>,
}

async fn get_boards_folder(
    State(state): State<AppState>,
    _principal: Principal,
) -> AppResult<Json<BoardsFolder>> {
    let folder =
        ref_files::boards_folder(&state.pools.read, state.config.boards_dir.as_deref()).await?;
    Ok(Json(BoardsFolder {
        folder: folder.map(|folder| folder.to_string_lossy().into_owned()),
    }))
}

#[derive(Debug, Deserialize)]
struct FolderBody {
    folder: String,
}

/// Settings → Board files: new boards go here; the files in the previous
/// folder move with it.
async fn put_boards_folder(
    State(state): State<AppState>,
    _principal: Principal,
    headers: HeaderMap,
    Json(body): Json<FolderBody>,
) -> AppResult<Json<BoardsFolder>> {
    own_origin(&headers)?;
    let folder = ref_files::set_boards_folder(
        &state.pools,
        &state.config.data_dir,
        state.config.boards_dir.as_deref(),
        &body.folder,
    )
    .await?;
    Ok(Json(BoardsFolder {
        folder: Some(folder.to_string_lossy().into_owned()),
    }))
}

#[derive(Debug, Deserialize)]
struct PathBody {
    path: String,
}

/// Only `RefThing`'s own pages (or no browser at all) may name paths: the
/// app is served from this machine (the embedded server, or the dev
/// server), a web page is not.
pub fn own_origin(headers: &HeaderMap) -> AppResult<()> {
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return Ok(());
    };
    let host = origin.strip_prefix("http://").unwrap_or_default();
    let host = host.split_once(':').map_or(host, |(host, port)| {
        if port.bytes().all(|b| b.is_ascii_digit()) {
            host
        } else {
            ""
        }
    });
    if matches!(host, "localhost" | "127.0.0.1") {
        Ok(())
    } else {
        Err(AppError::Unauthorized)
    }
}

async fn get_file(
    State(state): State<AppState>,
    _principal: Principal,
    Path(board_id): Path<Uuid>,
) -> AppResult<Json<Option<FileStatus>>> {
    Ok(Json(ref_files::status(&state.pools, board_id).await?))
}

async fn put_file(
    State(state): State<AppState>,
    _principal: Principal,
    headers: HeaderMap,
    Path(board_id): Path<Uuid>,
    Json(body): Json<PathBody>,
) -> AppResult<Json<FileStatus>> {
    own_origin(&headers)?;
    let status =
        ref_files::link(&state.pools, &state.config.data_dir, board_id, &body.path).await?;
    Ok(Json(status))
}

async fn delete_file(
    State(state): State<AppState>,
    _principal: Principal,
    headers: HeaderMap,
    Path(board_id): Path<Uuid>,
) -> AppResult<StatusCode> {
    own_origin(&headers)?;
    ref_files::unlink(&state.pools, board_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn open_file(
    State(state): State<AppState>,
    _principal: Principal,
    headers: HeaderMap,
    Json(body): Json<PathBody>,
) -> AppResult<(StatusCode, Json<Opened>)> {
    own_origin(&headers)?;
    let opened = ref_files::open(&state, &body.path).await?;
    let status = if opened.reused {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(opened)))
}

/// The board as a `.ref` file to download (the browser, with no file to
/// link): written to a temp file, streamed, removed once sent.
async fn download(
    State(state): State<AppState>,
    _principal: Principal,
    Path(board_id): Path<Uuid>,
) -> AppResult<Response> {
    let (name,): (String,) = sqlx::query_as("SELECT name FROM boards WHERE id = ?")
        .bind(board_id)
        .fetch_optional(&state.pools.read)
        .await?
        .ok_or(AppError::NotFound("board"))?;
    let data_dir = &state.config.data_dir;
    let temp = data_dir.join("tmp").join(format!("{}.ref", Uuid::now_v7()));
    let (blobs, derivatives) = (data_dir.join("blobs"), data_dir.join("deriv"));
    export::write_ref_file(
        &state.pools,
        Stores {
            blobs: &blobs,
            derivatives: &derivatives,
        },
        board_id,
        &temp,
    )
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?;
    let file = tokio::fs::File::open(&temp).await?;
    let length = file.metadata().await?.len();
    let chunks = stream::unfold(
        TempFile {
            file: Some(file),
            path: temp,
        },
        |mut temp| async move {
            let file = temp.file.as_mut()?;
            let mut chunk = vec![0u8; 256 * 1024];
            match file.read(&mut chunk).await {
                Ok(0) => None,
                Ok(read) => {
                    chunk.truncate(read);
                    Some((Ok::<_, std::io::Error>(Bytes::from(chunk)), temp))
                }
                Err(error) => {
                    temp.file = None;
                    Some((Err(error), temp))
                }
            }
        },
    );
    let body = Body::from_stream(chunks);
    let file_name = format!("{}.ref", ref_files::file_name_for(&name));
    let disposition = format!("attachment; filename=\"{file_name}\"");
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            ),
            (
                header::CONTENT_DISPOSITION,
                HeaderValue::from_str(&disposition).unwrap_or_else(|_| {
                    HeaderValue::from_static("attachment; filename=\"board.ref\"")
                }),
            ),
            (header::CONTENT_LENGTH, HeaderValue::from(length)),
        ],
        body,
    )
        .into_response())
}

/// A temp file being streamed: removed once the stream is done or dropped
/// (after its handle is closed, as Windows requires).
struct TempFile {
    file: Option<tokio::fs::File>,
    path: PathBuf,
}

impl Drop for TempFile {
    fn drop(&mut self) {
        self.file = None;
        let _ = std::fs::remove_file(&self.path);
    }
}
