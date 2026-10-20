//! A stored file's original as a file on disk under its own name: what the
//! desktop app hands the system to open in its default app (a PDF in the PDF
//! reader). Blobs are stored by hash, with no extension, so the system
//! couldn't tell what opens them.
//!
//! | route                                | does                                  |
//! |--------------------------------------|---------------------------------------|
//! | `POST /api/blobs/{hash}/open-copy`   | `{ path }` of `<data>/opened/<hash>/<name>` |
//!
//! It answers a path on this machine, so like the board-file routes only
//! `RefThing`'s own pages may ask. Programs and scripts get no copy: opening
//! one would run it — a board from someone else could carry `cute.pdf.exe` —
//! and they stay downloadable like anything else.

use std::path::Path as FsPath;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;
use uuid::Uuid;

use crate::auth::Principal;
use crate::error::{AppError, AppResult};
use crate::routes::board_files::own_origin;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/blobs/{hash}/open-copy", post(open_copy))
}

#[derive(Debug, Serialize)]
struct OpenCopy {
    path: String,
}

async fn open_copy(
    State(state): State<AppState>,
    _principal: Principal,
    headers: HeaderMap,
    Path(hash): Path<String>,
) -> AppResult<Json<OpenCopy>> {
    own_origin(&headers)?;
    let hash = hash.to_ascii_lowercase();
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::NotFound("blob"));
    }
    let (original, mime, size): (Option<String>, String, i64) =
        sqlx::query_as("SELECT original_filename, mime_type, byte_size FROM blobs WHERE hash = ?")
            .bind(&hash)
            .fetch_optional(&state.pools.read)
            .await?
            .ok_or(AppError::NotFound("blob"))?;

    let name = file_name(original.as_deref(), &mime, &hash);
    if runs_code(&name) {
        return Err(AppError::BadRequest(
            "RefThing doesn't open programs or scripts — download it instead".into(),
        ));
    }
    let folder = state.config.data_dir.join("opened").join(&hash[..16]);
    let target = folder.join(name);
    // The copy is rewritten unless it's still the original (it may have been
    // edited where it was opened).
    let current = tokio::fs::metadata(&target)
        .await
        .is_ok_and(|metadata| i64::try_from(metadata.len()).ok() == Some(size));
    if !current {
        tokio::fs::create_dir_all(&folder).await?;
        let temp = folder.join(format!(".{}.part", Uuid::now_v7()));
        tokio::fs::copy(state.blob_store.path(&hash), &temp).await?;
        if let Err(error) = tokio::fs::rename(&temp, &target).await {
            let _ = tokio::fs::remove_file(&temp).await;
            // Still open in another program (locked): that copy is the one.
            if !target.exists() {
                return Err(error.into());
            }
        }
    }
    Ok(Json(OpenCopy {
        path: target.to_string_lossy().into_owned(),
    }))
}

/// The original's name as any file system takes it, keeping its extension
/// (that's how the system picks the app); one from the type when it had none.
fn file_name(original: Option<&str>, mime: &str, hash: &str) -> String {
    let base = original
        .unwrap_or_default()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default();
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']);
    let stem = cleaned
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    let mut name = if cleaned.is_empty() || reserved {
        format!("{}{}", &hash[..12], if reserved { cleaned } else { "" })
    } else {
        cleaned.to_string()
    };
    if FsPath::new(&name).extension().is_none()
        && let Some(extension) = extension_for(mime)
    {
        name.push('.');
        name.push_str(extension);
    }
    // Keep paths well inside Windows' limit; the extension survives.
    if name.chars().count() > 120 {
        let extension = FsPath::new(&name)
            .extension()
            .map(|extension| format!(".{}", extension.to_string_lossy()))
            .filter(|extension| extension.chars().count() <= 16)
            .unwrap_or_default();
        let keep = 120 - extension.chars().count();
        name = name.chars().take(keep).collect::<String>() + &extension;
    }
    name
}

/// Whether the system would run the file rather than show it (Windows'
/// executable and script types, and links to them).
fn runs_code(name: &str) -> bool {
    let Some(extension) = FsPath::new(name).extension() else {
        return false;
    };
    let extension = extension.to_string_lossy().to_ascii_lowercase();
    matches!(
        extension.as_str(),
        "exe"
            | "com"
            | "scr"
            | "pif"
            | "bat"
            | "cmd"
            | "msi"
            | "msp"
            | "mst"
            | "cpl"
            | "dll"
            | "sys"
            | "drv"
            | "ocx"
            | "ps1"
            | "psm1"
            | "psd1"
            | "ps1xml"
            | "psc1"
            | "vb"
            | "vbs"
            | "vbe"
            | "js"
            | "jse"
            | "mjs"
            | "wsf"
            | "wsh"
            | "ws"
            | "wsc"
            | "hta"
            | "lnk"
            | "url"
            | "scf"
            | "reg"
            | "inf"
            | "msc"
            | "jar"
            | "appref-ms"
            | "application"
            | "appx"
            | "appxbundle"
            | "msix"
            | "msixbundle"
            | "gadget"
            | "chm"
            | "settingcontent-ms"
            | "library-ms"
            | "search-ms"
            | "searchconnector-ms"
            | "diagcab"
            | "xbap"
            | "sh"
            | "py"
            | "pyw"
    )
}

fn extension_for(mime: &str) -> Option<&'static str> {
    let mime = mime.split(';').next().unwrap_or_default().trim();
    Some(match mime {
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "text/html" => "html",
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "application/zip" => "zip",
        "model/gltf-binary" => "glb",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::{file_name, runs_code};

    #[test]
    fn programs_and_scripts_are_never_opened() {
        for name in [
            "cute.pdf.exe",
            "setup.MSI",
            "run.bat",
            "a.ps1",
            "x.lnk",
            "y.hta",
        ] {
            assert!(runs_code(name), "{name}");
        }
        for name in [
            "Brief.pdf",
            "notes.txt",
            "clip.mp4",
            "scene.blend",
            "README",
        ] {
            assert!(!runs_code(name), "{name}");
        }
    }

    const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn names_keep_their_extension_and_lose_what_windows_refuses() {
        assert_eq!(
            file_name(Some("Brief.pdf"), "application/pdf", HASH),
            "Brief.pdf"
        );
        assert_eq!(
            file_name(Some(r"..\..\a:b?.pdf"), "application/pdf", HASH),
            "a_b_.pdf"
        );
        assert_eq!(file_name(Some("notes. "), "text/plain", HASH), "notes.txt");
        assert_eq!(file_name(None, "application/pdf", HASH), "0123456789ab.pdf");
        assert_eq!(
            file_name(Some("CON.pdf"), "application/pdf", HASH),
            "0123456789abCON.pdf"
        );
        let long = format!("{}.pdf", "x".repeat(300));
        let name = file_name(Some(&long), "application/pdf", HASH);
        assert_eq!(name.chars().count(), 120);
        assert_eq!(
            name.rsplit_once('.').map(|(_, extension)| extension),
            Some("pdf")
        );
    }
}
