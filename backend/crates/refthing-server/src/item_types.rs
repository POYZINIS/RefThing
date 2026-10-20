//! Item type handlers (plan Phase 11, docs/onboarding-new-item-type.md).
//!
//! Every ingested file is routed by its sniffed MIME to exactly one handler,
//! which decides the item `type`, reads the intrinsic size (so the item is
//! placed at its true proportions) plus type metadata, and names the job that
//! makes its poster. Adding a type = one handler here + one frontend renderer;
//! nothing in the engine, schema or sync protocol changes.

use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};

/// Longest edge a new item is placed at, in world px. Images keep their
/// native size below this; larger ones scale down, proportions preserved.
pub const MAX_PLACED_EDGE: f64 = 1600.0;

/// What a handler learned about a file at ingest.
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    /// Intrinsic pixel size (a media frame's, for video).
    pub width: u32,
    pub height: u32,
    /// Type metadata merged into `item_metadata` (e.g. `duration`).
    pub metadata: Value,
}

#[async_trait]
pub trait ItemTypeHandler: Send + Sync {
    /// The `items.type` this handler owns.
    fn item_type(&self) -> &'static str;
    /// Whether this handler takes a sniffed MIME type.
    fn accepts(&self, mime: &str) -> bool;
    /// Fast intrinsic probe of the stored file (header / ffprobe), or `None`
    /// when it can't be read.
    async fn probe(&self, path: &Path) -> Option<Probe>;
    /// The placement size for a probe (world px).
    fn placement(&self, probe: Option<&Probe>) -> (f64, f64);
    /// Job kind that generates the poster derivatives, if any.
    fn poster_job(&self) -> Option<&'static str>;
}

/// Fit a pixel size under [`MAX_PLACED_EDGE`], keeping proportions.
fn fit(width: u32, height: u32) -> (f64, f64) {
    let (w, h) = (f64::from(width.max(1)), f64::from(height.max(1)));
    let scale = (MAX_PLACED_EDGE / w.max(h)).min(1.0);
    (w * scale, h * scale)
}

pub struct ImageHandler;
pub struct VideoHandler;
pub struct AudioHandler;
/// 3D models (GLB / glTF / FBX / .blend): the client renders the views.
pub struct ModelHandler;
/// Catch-all: any file lands on the board as a card (poster drawn by the
/// client) and stays downloadable.
pub struct FileHandler;

#[async_trait]
impl ItemTypeHandler for ImageHandler {
    fn item_type(&self) -> &'static str {
        "image"
    }
    fn accepts(&self, mime: &str) -> bool {
        mime.starts_with("image/")
    }
    async fn probe(&self, path: &Path) -> Option<Probe> {
        let path = path.to_path_buf();
        let (width, height) =
            tokio::task::spawn_blocking(move || crate::jobs::pyramid::probe_dimensions(&path).ok())
                .await
                .ok()??;
        Some(Probe {
            width,
            height,
            metadata: json!({}),
        })
    }
    fn placement(&self, probe: Option<&Probe>) -> (f64, f64) {
        probe.map_or((256.0, 256.0), |probe| fit(probe.width, probe.height))
    }
    fn poster_job(&self) -> Option<&'static str> {
        Some("pyramid")
    }
}

#[async_trait]
impl ItemTypeHandler for VideoHandler {
    fn item_type(&self) -> &'static str {
        "video"
    }
    fn accepts(&self, mime: &str) -> bool {
        mime.starts_with("video/")
    }
    async fn probe(&self, path: &Path) -> Option<Probe> {
        let info = ffprobe(path).await?;
        let stream = info["streams"]
            .as_array()?
            .iter()
            .find(|stream| stream["width"].is_u64())?;
        let width = u32::try_from(stream["width"].as_u64()?).ok()?;
        let height = u32::try_from(stream["height"].as_u64()?).ok()?;
        Some(Probe {
            width,
            height,
            metadata: duration_of(&info),
        })
    }
    fn placement(&self, probe: Option<&Probe>) -> (f64, f64) {
        probe.map_or((480.0, 270.0), |probe| fit(probe.width, probe.height))
    }
    fn poster_job(&self) -> Option<&'static str> {
        Some("media_poster")
    }
}

#[async_trait]
impl ItemTypeHandler for AudioHandler {
    fn item_type(&self) -> &'static str {
        "audio"
    }
    fn accepts(&self, mime: &str) -> bool {
        mime.starts_with("audio/")
    }
    async fn probe(&self, path: &Path) -> Option<Probe> {
        // The length from ffprobe, else from the container itself (no ffmpeg
        // needed for the common formats).
        let metadata = if let Some(info) = ffprobe(path).await {
            duration_of(&info)
        } else {
            let path = path.to_path_buf();
            let seconds = tokio::task::spawn_blocking(move || {
                refthing_core::pipeline::waveform::audio_duration(&path, None)
            })
            .await
            .ok()
            .flatten();
            seconds.map_or_else(|| json!({}), |duration| json!({ "duration": duration }))
        };
        // The waveform tile: the poster job renders it at this shape.
        Some(Probe {
            width: refthing_core::pipeline::waveform::TILE_WIDTH,
            height: refthing_core::pipeline::waveform::TILE_HEIGHT,
            metadata,
        })
    }
    fn placement(&self, _probe: Option<&Probe>) -> (f64, f64) {
        (480.0, 120.0)
    }
    fn poster_job(&self) -> Option<&'static str> {
        Some("media_poster")
    }
}

#[async_trait]
impl ItemTypeHandler for ModelHandler {
    fn item_type(&self) -> &'static str {
        "model"
    }
    fn accepts(&self, mime: &str) -> bool {
        mime.starts_with("model/") || mime == BLEND_MIME
    }
    async fn probe(&self, _path: &Path) -> Option<Probe> {
        None
    }
    fn placement(&self, _probe: Option<&Probe>) -> (f64, f64) {
        // A 4:3 viewport.
        (640.0, 480.0)
    }
    fn poster_job(&self) -> Option<&'static str> {
        // Views are rendered by the client (they follow each item's camera).
        None
    }
}

#[async_trait]
impl ItemTypeHandler for FileHandler {
    fn item_type(&self) -> &'static str {
        "file"
    }
    fn accepts(&self, _mime: &str) -> bool {
        true
    }
    async fn probe(&self, _path: &Path) -> Option<Probe> {
        None
    }
    fn placement(&self, _probe: Option<&Probe>) -> (f64, f64) {
        (200.0, 240.0)
    }
    fn poster_job(&self) -> Option<&'static str> {
        None
    }
}

/// Registry, most specific first; [`FileHandler`] catches everything else.
static HANDLERS: [&dyn ItemTypeHandler; 5] = [
    &ImageHandler,
    &VideoHandler,
    &AudioHandler,
    &ModelHandler,
    &FileHandler,
];

/// The handler for a sniffed MIME type (always one: files are the fallback).
#[must_use]
pub fn handler_for(mime: &str) -> &'static dyn ItemTypeHandler {
    HANDLERS
        .iter()
        .copied()
        .find(|handler| handler.accepts(mime))
        .unwrap_or(&FileHandler)
}

// ------------------------------------------------------------------ models

pub const GLB_MIME: &str = "model/gltf-binary";
pub const GLTF_MIME: &str = "model/gltf+json";
pub const FBX_MIME: &str = "model/x-fbx";
pub const BLEND_MIME: &str = "application/x-blender";

/// The general sniffer (`infer`) knows no 3D formats, and some audio ones
/// (CAF, `WavPack`, TTA, Musepack, Sun AU): recognize them by magic bytes,
/// then — for files it could only call generic (ASCII FBX, glTF JSON,
/// compressed .blend, AC-3, DTS) — by extension. Anything else keeps the
/// sniffed type. (Audio in a video container: [`audio_container_mime`].)
#[must_use]
pub fn refine_mime(sniffed: &str, filename: Option<&str>, head: &[u8]) -> String {
    if head.starts_with(b"glTF") {
        return GLB_MIME.to_string();
    }
    if head.starts_with(b"Kaydara FBX Binary") {
        return FBX_MIME.to_string();
    }
    if head.starts_with(b"BLENDER") {
        return BLEND_MIME.to_string();
    }
    if !sniffed.starts_with("audio/") {
        for (magic, mime) in AUDIO_MAGIC {
            if head.starts_with(magic) {
                return (*mime).to_string();
            }
        }
    }
    let generic = matches!(
        sniffed,
        "application/octet-stream"
            | "application/zstd"
            | "application/gzip"
            | "application/x-gzip"
            | "application/json"
            | "text/plain"
    );
    let extension = filename
        .and_then(|name| Path::new(name).extension())
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    match (generic, extension.as_deref()) {
        (true, Some("blend")) => BLEND_MIME.to_string(),
        (true, Some("fbx")) => FBX_MIME.to_string(),
        (true, Some("gltf")) => GLTF_MIME.to_string(),
        (true, Some("glb")) => GLB_MIME.to_string(),
        (true, Some(extension)) => AUDIO_EXTENSIONS
            .iter()
            .find(|(known, _)| *known == extension)
            .map_or_else(|| sniffed.to_string(), |(_, mime)| (*mime).to_string()),
        _ => sniffed.to_string(),
    }
}

/// Audio containers `infer` doesn't know, by their opening bytes.
const AUDIO_MAGIC: &[(&[u8], &str)] = &[
    (b"caff", "audio/x-caf"),
    (b"wvpk", "audio/x-wavpack"),
    (b"TTA1", "audio/x-tta"),
    (b"MPCK", "audio/x-musepack"),
    (b".snd", "audio/basic"),
];

/// Audio with no reliable magic (raw AC-3 / DTS streams), and audio-only
/// Matroska / `WebM` / ASF named as such, when the sniffer found nothing.
const AUDIO_EXTENSIONS: &[(&str, &str)] = &[
    ("ac3", "audio/ac3"),
    ("eac3", "audio/eac3"),
    ("dts", "audio/vnd.dts"),
    ("mka", "audio/x-matroska"),
    ("weba", "audio/webm"),
    ("wma", "audio/x-ms-wma"),
    ("ra", "audio/x-pn-realaudio"),
];

/// A file the sniffer called a video by its container (Matroska/WebM, MP4,
/// ASF) whose track list holds audio and no video: its audio type.
/// Reads the file's header (blocking — run off the async workers).
#[must_use]
pub fn audio_container_mime(sniffed: &str, path: &Path) -> Option<&'static str> {
    let family = refthing_core::media::Family::of_video_mime(sniffed)?;
    let mut file = std::fs::File::open(path).ok()?;
    let tracks = refthing_core::media::tracks(family, &mut file).ok()?;
    (tracks.audio && !tracks.video).then(|| family.audio_mime(sniffed == "video/webm"))
}

// ------------------------------------------------------------------ ffmpeg

/// The ffmpeg tool binary: `REFTHING_FFMPEG` / `REFTHING_FFPROBE`, else the
/// name on PATH. Media posters are best-effort: without ffmpeg, items still
/// ingest and the client draws a card poster.
#[must_use]
pub fn tool(name: &str) -> String {
    let key = format!("REFTHING_{}", name.to_ascii_uppercase());
    std::env::var(key).unwrap_or_else(|_| name.to_string())
}

async fn ffprobe(path: &Path) -> Option<Value> {
    let output = tokio::time::timeout(
        Duration::from_secs(15),
        tokio::process::Command::new(tool("ffprobe"))
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=width,height:format=duration",
            ])
            .args(["-of", "json"])
            .arg(path)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn duration_of(info: &Value) -> Value {
    info["format"]["duration"]
        .as_str()
        .and_then(|seconds| seconds.parse::<f64>().ok())
        .map_or_else(|| json!({}), |duration| json!({ "duration": duration }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_by_mime_with_files_as_the_fallback() {
        assert_eq!(handler_for("image/png").item_type(), "image");
        assert_eq!(handler_for("video/mp4").item_type(), "video");
        assert_eq!(handler_for("audio/mpeg").item_type(), "audio");
        assert_eq!(handler_for("application/zip").item_type(), "file");
        assert_eq!(handler_for("application/octet-stream").poster_job(), None);
        assert_eq!(handler_for("image/gif").poster_job(), Some("pyramid"));
        assert_eq!(handler_for("video/webm").poster_job(), Some("media_poster"));
        assert_eq!(handler_for(GLB_MIME).item_type(), "model");
        assert_eq!(handler_for(FBX_MIME).item_type(), "model");
        assert_eq!(handler_for(BLEND_MIME).item_type(), "model");
        assert_eq!(handler_for(GLB_MIME).poster_job(), None);
    }

    #[test]
    fn recognizes_models_by_magic_then_extension() {
        let octet = "application/octet-stream";
        assert_eq!(refine_mime(octet, None, b"glTF\x02\0\0\0"), GLB_MIME);
        assert_eq!(
            refine_mime(octet, Some("a.bin"), b"Kaydara FBX Binary  \0"),
            FBX_MIME
        );
        assert_eq!(refine_mime(octet, None, b"BLENDER-v300"), BLEND_MIME);
        // Compressed .blend (zstd) and text formats: by extension.
        assert_eq!(
            refine_mime("application/zstd", Some("Scene.BLEND"), &[0x28, 0xb5]),
            BLEND_MIME
        );
        assert_eq!(
            refine_mime(octet, Some("rig.fbx"), b"; FBX 7.4.0"),
            FBX_MIME
        );
        assert_eq!(refine_mime("text/plain", Some("x.gltf"), b"{"), GLTF_MIME);
        // A real type is never overridden by a misleading extension.
        assert_eq!(
            refine_mime("image/png", Some("x.glb"), b"\x89PNG"),
            "image/png"
        );
        assert_eq!(refine_mime(octet, Some("notes.txt"), b"hello"), octet);
    }

    #[test]
    fn recognizes_audio_the_sniffer_misses() {
        let octet = "application/octet-stream";
        assert_eq!(
            refine_mime(octet, Some("a.caf"), b"caff\0\x01"),
            "audio/x-caf"
        );
        assert_eq!(
            refine_mime(octet, None, b"wvpk\x20\0\0\0"),
            "audio/x-wavpack"
        );
        assert_eq!(
            refine_mime(octet, Some("Mix.AC3"), &[0x0B, 0x77]),
            "audio/ac3"
        );
        assert_eq!(
            refine_mime(octet, Some("x.weba"), b"\x1a\x45"),
            "audio/webm"
        );
        assert_eq!(handler_for("audio/ac3").item_type(), "audio");
        // A sniffed type stands; an unknown extension changes nothing.
        assert_eq!(
            refine_mime("audio/mpeg", Some("a.ac3"), b"ID3"),
            "audio/mpeg"
        );
        assert_eq!(refine_mime(octet, Some("a.xyz"), b"\0\0"), octet);
    }

    #[test]
    fn audio_only_containers_are_audio_and_videos_stay_videos() {
        let fixture = |name: &str| {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../refthing-core/tests/fixtures/media")
                .join(name)
        };
        let check = |sniffed, name| audio_container_mime(sniffed, &fixture(name));
        assert_eq!(check("video/webm", "tone.weba"), Some("audio/webm"));
        assert_eq!(check("video/webm", "tone.mka"), Some("audio/webm"));
        assert_eq!(
            check("video/x-matroska", "tone.mka"),
            Some("audio/x-matroska")
        );
        assert_eq!(check("video/x-ms-wmv", "tone.wma"), Some("audio/x-ms-wma"));
        assert_eq!(check("video/mp4", "tone-audio-only.mp4"), Some("audio/mp4"));
        assert_eq!(check("video/webm", "clip.webm"), None);
        assert_eq!(check("video/mp4", "clip.mp4"), None);
        assert_eq!(check("video/x-ms-wmv", "clip.wmv"), None);
        // Not a container we read: untouched.
        assert_eq!(check("audio/mpeg", "tone.mp3"), None);
    }

    #[test]
    fn placement_keeps_proportions_and_caps_the_long_edge() {
        let probe = |width, height| Probe {
            width,
            height,
            metadata: json!({}),
        };
        assert_eq!(
            ImageHandler.placement(Some(&probe(400, 100))),
            (400.0, 100.0)
        );
        assert_eq!(
            ImageHandler.placement(Some(&probe(3200, 1600))),
            (1600.0, 800.0)
        );
        assert_eq!(ImageHandler.placement(None), (256.0, 256.0));
        assert_eq!(
            VideoHandler.placement(Some(&probe(1920, 1080))),
            (1600.0, 900.0)
        );
    }
}
