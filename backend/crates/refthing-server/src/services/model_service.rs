//! 3D model bytes for the client's viewer (`GET /blob/{hash}/model`).
//!
//! GLB, glTF and FBX are read by the browser as stored. A `.blend` has no
//! browser reader, so the first request converts it to GLB with headless
//! Blender (when installed) and caches the result next to the blob's other
//! derivatives; later requests stream the cache. One conversion per blob at
//! a time — concurrent requests wait for the first.
//!
//! Blender runs with factory settings and script auto-execution disabled,
//! so a `.blend` can't run its embedded Python.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::Duration;

use dashmap::DashMap;
use tokio::sync::Mutex;

use crate::item_types::BLEND_MIME;
use crate::state::AppState;

/// Longest a conversion may run.
const CONVERT_TIMEOUT: Duration = Duration::from_secs(300);

/// Exports every visible object as one GLB. A file Blender couldn't read
/// leaves its startup scene open — that must fail, not export a default
/// cube. Keyword arguments differ across Blender versions, so the extras
/// are tried first and dropped if refused.
const EXPORT_SCRIPT: &str = r#"
import bpy, sys
if not bpy.data.filepath:
    sys.exit(1)
out = sys.argv[sys.argv.index("--") + 1]
base = dict(filepath=out, export_format="GLB", export_apply=True)
extras = dict(use_visible=True, export_animations=False, export_cameras=False, export_lights=False)
try:
    bpy.ops.export_scene.gltf(**base, **extras)
except TypeError:
    bpy.ops.export_scene.gltf(**base)
"#;

/// Where a model's viewer bytes come from.
pub enum ModelSource {
    /// The stored blob is readable as is.
    Original,
    /// A converted GLB on disk.
    Converted(PathBuf),
}

/// Why a model can't be served.
#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("needs Blender to open .blend files")]
    NoBlender,
    #[error("Blender couldn't convert this file")]
    ConvertFailed,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Is this blob a Blender file? (Uncompressed ones start with `BLENDER`;
/// compressed ones are recognized by the MIME ingest gave them.)
#[must_use]
pub fn is_blend(mime: &str, head: &[u8]) -> bool {
    mime == BLEND_MIME || head.starts_with(b"BLENDER")
}

static CONVERSIONS: LazyLock<DashMap<String, Arc<Mutex<()>>>> = LazyLock::new(DashMap::new);

/// The viewer bytes for a model blob, converting a `.blend` on first use.
pub async fn model_source(
    state: &AppState,
    hash: &str,
    mime: &str,
) -> Result<ModelSource, ModelError> {
    let original = state.blob_store.path(hash);
    let head = read_head(&original).await?;
    if !is_blend(mime, &head) {
        return Ok(ModelSource::Original);
    }
    let cached = converted_path(&state.config.data_dir, hash);
    if tokio::fs::metadata(&cached).await.is_ok() {
        return Ok(ModelSource::Converted(cached));
    }
    let lock = CONVERSIONS
        .entry(hash.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone();
    let _guard = lock.lock().await;
    // Another request may have finished it while this one waited.
    if tokio::fs::metadata(&cached).await.is_ok() {
        return Ok(ModelSource::Converted(cached));
    }
    let blender = blender_path().ok_or(ModelError::NoBlender)?;
    convert(&blender, &original, &cached).await?;
    Ok(ModelSource::Converted(cached))
}

async fn read_head(path: &Path) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path).await?;
    let mut head = vec![0u8; 16];
    let read = file.read(&mut head).await?;
    head.truncate(read);
    Ok(head)
}

/// `<data_dir>/deriv/<ab>/<cd>/<hash>/model.glb`, beside the pyramid levels.
#[must_use]
pub fn converted_path(data_dir: &Path, hash: &str) -> PathBuf {
    data_dir
        .join("deriv")
        .join(&hash[0..2])
        .join(&hash[2..4])
        .join(hash)
        .join("model.glb")
}

async fn convert(blender: &Path, original: &Path, output: &Path) -> Result<(), ModelError> {
    let dir = output.parent().ok_or(ModelError::ConvertFailed)?;
    tokio::fs::create_dir_all(dir).await?;
    // Blender wants the .blend extension to open a file.
    let input = dir.join("source.blend");
    let partial = dir.join("model.partial.glb");
    tokio::fs::copy(original, &input).await?;
    let run = tokio::process::Command::new(blender)
        .args(["--background", "--factory-startup", "--disable-autoexec"])
        .arg(&input)
        // A Python error must fail the run (Blender exits 0 by default).
        .args([
            "--python-exit-code",
            "1",
            "--python-expr",
            EXPORT_SCRIPT,
            "--",
        ])
        .arg(&partial)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status();
    let finished = tokio::time::timeout(CONVERT_TIMEOUT, run).await;
    let _ = tokio::fs::remove_file(&input).await;
    let converted = matches!(finished, Ok(Ok(status)) if status.success())
        && tokio::fs::metadata(&partial)
            .await
            .is_ok_and(|meta| meta.len() > 0);
    if !converted {
        let _ = tokio::fs::remove_file(&partial).await;
        tracing::info!(file = %original.display(), "blend conversion failed");
        return Err(ModelError::ConvertFailed);
    }
    tokio::fs::rename(&partial, output).await?;
    Ok(())
}

// ---------------------------------------------------------------- Blender

/// The Blender binary: `REFTHING_BLENDER`, else `blender` on PATH, else the
/// usual install places (Blender Foundation, Steam libraries, macOS app).
/// Looked up once.
pub fn blender_path() -> Option<PathBuf> {
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND.get_or_init(find_blender).clone()
}

fn find_blender() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("REFTHING_BLENDER") {
        return Some(PathBuf::from(path));
    }
    let exe = if cfg!(windows) {
        "blender.exe"
    } else {
        "blender"
    };
    let on_path: Vec<PathBuf> = std::env::var_os("PATH").map_or_else(Vec::new, |paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(exe))
            .collect()
    });
    on_path
        .into_iter()
        .chain(install_candidates())
        .find(|candidate| candidate.is_file())
}

fn install_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from(
            "/Applications/Blender.app/Contents/MacOS/Blender",
        ));
    }
    if cfg!(windows) {
        for root in ["ProgramFiles", "ProgramW6432"] {
            let Some(root) = std::env::var_os(root) else {
                continue;
            };
            // Newest version first ("Blender 4.2" < "Blender 5.2").
            let foundation = PathBuf::from(root).join("Blender Foundation");
            let mut versions: Vec<PathBuf> = std::fs::read_dir(&foundation)
                .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
                .unwrap_or_default();
            versions.sort();
            candidates.extend(
                versions
                    .into_iter()
                    .rev()
                    .map(|dir| dir.join("blender.exe")),
            );
        }
        for library in steam_libraries() {
            candidates.push(
                library
                    .join("steamapps")
                    .join("common")
                    .join("Blender")
                    .join("blender.exe"),
            );
        }
    }
    candidates
}

/// Steam library folders (the default install plus `libraryfolders.vdf`).
fn steam_libraries() -> Vec<PathBuf> {
    let Some(root) = std::env::var_os("ProgramFiles(x86)") else {
        return Vec::new();
    };
    let steam = PathBuf::from(root).join("Steam");
    let mut libraries = vec![steam.clone()];
    if let Ok(vdf) = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf")) {
        libraries.extend(vdf_paths(&vdf));
    }
    libraries
}

/// The `"path"` values of a Steam `libraryfolders.vdf`.
fn vdf_paths(vdf: &str) -> Vec<PathBuf> {
    vdf.lines()
        .filter_map(|line| {
            let mut fields = line.split('"').filter(|field| !field.trim().is_empty());
            (fields.next()? == "path")
                .then(|| fields.next())
                .flatten()
                .map(|path| PathBuf::from(path.replace("\\\\", "\\")))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_blend_files() {
        assert!(is_blend("application/octet-stream", b"BLENDER-v300RENDH"));
        assert!(is_blend(BLEND_MIME, &[0x28, 0xb5, 0x2f, 0xfd]));
        assert!(!is_blend("model/gltf-binary", b"glTF\x02\0\0\0"));
    }

    #[test]
    fn reads_steam_library_paths() {
        let vdf = "\"libraryfolders\"\n{\n\t\"0\"\n\t{\n\t\t\"path\"\t\t\"C:\\\\Program Files (x86)\\\\Steam\"\n\t}\n\t\"1\"\n\t{\n\t\t\"path\"\t\t\"D:\\\\SteamLibrary\"\n\t\t\"label\"\t\t\"\"\n\t}\n}\n";
        assert_eq!(
            vdf_paths(vdf),
            vec![
                PathBuf::from("C:\\Program Files (x86)\\Steam"),
                PathBuf::from("D:\\SteamLibrary"),
            ]
        );
    }
}
