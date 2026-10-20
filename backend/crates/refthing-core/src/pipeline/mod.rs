//! Image pyramid pipeline: decode a blob once and re-encode it into the
//! `thumb`/`small`/`medium` WebP derivative levels served by
//! `/blob/{hash}/{level}`. `full` is always the original bytes (passthrough).
//!
//! All heavy work is synchronous and must run on [`ResizePool`], a dedicated
//! rayon pool bridged to tokio via oneshot channels.

mod generate;
mod palette;
mod pool;
pub mod waveform;

use std::path::PathBuf;

pub use generate::{generate_poster_pyramid, generate_pyramid};
pub use palette::{
    ImageMetadata, dominant_colors, extract_image_metadata, hamming_distance, phash,
};
pub use pool::ResizePool;

/// Decompression-bomb guard: decoded images above this pixel count are
/// rejected. At 4 bytes/pixel this also caps the decode allocation at 2 GiB.
pub const MAX_PIXELS: u64 = 512 * 1000 * 1000;

/// One derivative level of the image pyramid, keyed by longest edge.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum PyramidLevel {
    Thumb,
    Small,
    Medium,
    /// The original bytes; never generated, always present.
    Full,
}

impl PyramidLevel {
    /// Levels generated as WebP files; [`PyramidLevel::Full`] is the original
    /// blob and never generated. Ascending size order.
    pub const ALL: [Self; 3] = [Self::Thumb, Self::Small, Self::Medium];

    /// Longest-edge bound of the level in pixels.
    #[must_use]
    pub const fn max_edge(self) -> u32 {
        match self {
            Self::Thumb => 64,
            Self::Small => 256,
            Self::Medium => 1024,
            Self::Full => u32::MAX,
        }
    }

    /// Lossy WebP quality for the level.
    #[must_use]
    pub const fn quality(self) -> f32 {
        match self {
            Self::Thumb => 72.0,
            Self::Small => 75.0,
            Self::Medium => 80.0,
            Self::Full => 100.0,
        }
    }

    /// Database/URL representation of the level.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Thumb => "thumb",
            Self::Small => "small",
            Self::Medium => "medium",
            Self::Full => "full",
        }
    }

    /// Inverse of [`PyramidLevel::as_str`].
    #[must_use]
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "thumb" => Some(Self::Thumb),
            "small" => Some(Self::Small),
            "medium" => Some(Self::Medium),
            "full" => Some(Self::Full),
            _ => None,
        }
    }

    /// Levels that get a generated WebP file for an original whose longest
    /// edge is `orig_max_edge` pixels, in ascending size order. Levels at or
    /// above the original are skipped (never upscale); the DB layer records
    /// those as aliases of `full`.
    #[must_use]
    pub fn derivable_levels(orig_max_edge: u32) -> Vec<Self> {
        Self::ALL
            .into_iter()
            .filter(|level| orig_max_edge > level.max_edge())
            .collect()
    }
}

/// A generated derivative file, ready to be recorded in `blob_derivatives`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivativeRecord {
    pub level: PyramidLevel,
    pub width: u32,
    pub height: u32,
    pub byte_size: u64,
    /// Always `image/webp` for generated levels.
    pub format: String,
    /// File path relative to the derivative root passed to
    /// [`generate_pyramid`]: `<hash[0..2]>/<hash[2..4]>/<hash>/<level>.webp`.
    pub rel_path: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum PipelineError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("failed to decode image: {0}")]
    Decode(#[from] image::ImageError),
    #[error("image is {width}x{height}, over the 512-megapixel safety limit")]
    TooLarge { width: u32, height: u32 },
    #[error("failed to resize image: {0}")]
    Resize(String),
    #[error("failed to encode WebP: {0}")]
    WebpEncode(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVERY_LEVEL: [PyramidLevel; 4] = [
        PyramidLevel::Thumb,
        PyramidLevel::Small,
        PyramidLevel::Medium,
        PyramidLevel::Full,
    ];

    #[test]
    fn as_str_round_trips_through_parse() {
        for level in EVERY_LEVEL {
            assert_eq!(PyramidLevel::parse(level.as_str()), Some(level));
        }
        assert_eq!(PyramidLevel::parse("thumbnail"), None);
        assert_eq!(PyramidLevel::parse("Thumb"), None);
        assert_eq!(PyramidLevel::parse(""), None);
    }

    #[test]
    fn level_bounds_and_qualities_match_the_scheme() {
        assert_eq!(PyramidLevel::Thumb.max_edge(), 64);
        assert_eq!(PyramidLevel::Small.max_edge(), 256);
        assert_eq!(PyramidLevel::Medium.max_edge(), 1024);
        assert_eq!(PyramidLevel::Full.max_edge(), u32::MAX);
        assert_eq!(PyramidLevel::Thumb.quality().to_bits(), 72.0f32.to_bits());
        assert_eq!(PyramidLevel::Small.quality().to_bits(), 75.0f32.to_bits());
        assert_eq!(PyramidLevel::Medium.quality().to_bits(), 80.0f32.to_bits());
        assert_eq!(PyramidLevel::Full.quality().to_bits(), 100.0f32.to_bits());
    }

    #[test]
    fn derivable_levels_skips_levels_at_or_above_the_original() {
        assert_eq!(
            PyramidLevel::derivable_levels(2400),
            vec![
                PyramidLevel::Thumb,
                PyramidLevel::Small,
                PyramidLevel::Medium
            ]
        );
        // Exact bound: medium aliases the original, never a re-encode.
        assert_eq!(
            PyramidLevel::derivable_levels(1024),
            vec![PyramidLevel::Thumb, PyramidLevel::Small]
        );
        assert_eq!(
            PyramidLevel::derivable_levels(200),
            vec![PyramidLevel::Thumb]
        );
        assert_eq!(PyramidLevel::derivable_levels(64), vec![]);
    }
}
