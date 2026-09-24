//! Dominant color extraction and perceptual hashing for images.
//!
//! These are pure CPU functions that run on the [`ResizePool`] rayon pool
//! alongside pyramid generation. [`extract_image_metadata`] decodes once
//! and computes both in a single pass.

use std::path::Path;

use image::RgbaImage;

use super::PipelineError;
use super::generate::decode_normalized;

/// Result of computing visual metadata for one image.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImageMetadata {
    /// Up to 5 dominant hex colours, most frequent first.
    pub dominant_colors: Vec<String>,
    /// 64-bit difference hash as 16-char hex.
    pub phash: String,
}

/// Decode an image once and compute both dominant colours and perceptual hash.
///
/// # Errors
/// Returns `PipelineError` on decode failure (same as pyramid generation).
pub fn extract_image_metadata(path: &Path) -> Result<ImageMetadata, PipelineError> {
    let rgba = decode_normalized(path)?;
    Ok(ImageMetadata {
        dominant_colors: dominant_colors(&rgba),
        phash: phash(&rgba),
    })
}

/// Number of dominant colors returned by [`dominant_colors`].
const PALETTE_SIZE: usize = 5;

/// Downscale target for color bucketing (small = fast).
const QUANT_SIZE: u32 = 32;

/// Quantize each channel to `BITS_PER_CHANNEL` bits for bucketing.
const BITS_PER_CHANNEL: u8 = 4;

/// Returns up to `PALETTE_SIZE` dominant hex colours (e.g. `"#a1b2c3"`),
/// most frequent first.  Empty for degenerate images.
#[must_use]
pub fn dominant_colors(rgba: &RgbaImage) -> Vec<String> {
    let small = image::imageops::resize(
        rgba,
        QUANT_SIZE,
        QUANT_SIZE,
        image::imageops::FilterType::Nearest,
    );

    // (quantised_color, count)
    let mut buckets: Vec<(u32, u32)> = Vec::with_capacity(1024);
    for pixel in small.pixels() {
        let [r, g, b, a] = pixel.0;
        if a == 0 {
            continue;
        }
        let shift = 8 - BITS_PER_CHANNEL;
        let qr = r >> shift;
        let qg = g >> shift;
        let qb = b >> shift;
        let key = u32::from(qr) << 16 | u32::from(qg) << 8 | u32::from(qb);
        if let Some(entry) = buckets.iter_mut().find(|(k, _)| *k == key) {
            entry.1 += 1;
        } else {
            buckets.push((key, 1));
        }
    }

    buckets.sort_by_key(|entry| std::cmp::Reverse(entry.1));
    buckets
        .into_iter()
        .take(PALETTE_SIZE)
        .map(|(key, _)| {
            let shift = 8 - BITS_PER_CHANNEL;
            let r = ((key >> 16) & 0xFF) << shift | ((1 << shift) - 1);
            let g = ((key >> 8) & 0xFF) << shift | ((1 << shift) - 1);
            let b = (key & 0xFF) << shift | ((1 << shift) - 1);
            format!("#{r:02x}{g:02x}{b:02x}")
        })
        .collect()
}

/// Compute a 64-bit difference hash (dHash) for near-duplicate detection.
///
/// Returns a 16-character lowercase hex string (64 bits).
///
/// Algorithm: downscale to 9×8 greyscale, compare each horizontal pair —
/// a 1-bit is set when the left pixel is brighter than the right.
#[must_use]
pub fn phash(rgba: &RgbaImage) -> String {
    let gray = image::imageops::resize(rgba, 9, 8, image::imageops::FilterType::Nearest);

    let mut hash: u64 = 0;
    let mut bit = 0u32;
    for y in 0..8 {
        for x in 0..8u32 {
            let left = grayscale(*gray.get_pixel(x, y));
            let right = grayscale(*gray.get_pixel(x + 1, y));
            if left > right {
                hash |= 1 << bit;
            }
            bit += 1;
            if bit >= 64 {
                return format!("{hash:016x}");
            }
        }
    }
    format!("{hash:016x}")
}

#[must_use]
fn grayscale(pixel: image::Rgba<u8>) -> u8 {
    let [r, g, b, _] = pixel.0;
    let luma = u32::from(r) * 299 + u32::from(g) * 587 + u32::from(b) * 114;
    u8::try_from(luma / 1000).unwrap_or(255)
}

/// Hamming distance between two hex-encoded 64-bit phashes.
#[must_use]
pub fn hamming_distance(a: &str, b: &str) -> Option<u32> {
    let a_val = u64::from_str_radix(a, 16).ok()?;
    let b_val = u64::from_str_radix(b, 16).ok()?;
    Some((a_val ^ b_val).count_ones())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dominant_colors_returns_up_to_five() {
        let img = RgbaImage::from_fn(4, 4, |_, _| image::Rgba([255, 0, 0, 255]));
        let colors = dominant_colors(&img);
        assert!(!colors.is_empty());
        assert!(colors.len() <= PALETTE_SIZE);
        assert!(colors[0].starts_with('#'));
    }

    #[test]
    fn phash_deterministic() {
        let img = RgbaImage::from_fn(100, 100, |x, y| {
            image::Rgba([
                u8::try_from(x % 256).unwrap(),
                u8::try_from(y % 256).unwrap(),
                128,
                255,
            ])
        });
        let h1 = phash(&img);
        let h2 = phash(&img);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 16);
    }

    #[test]
    fn hamming_same_is_zero() {
        assert_eq!(
            hamming_distance("aabbccdd00112233", "aabbccdd00112233"),
            Some(0)
        );
    }

    #[test]
    fn hamming_different() {
        assert_eq!(
            hamming_distance("0000000000000000", "ffffffffffffffff"),
            Some(64)
        );
    }

    #[test]
    fn hamming_invalid_hex() {
        assert!(hamming_distance("zzzz", "aaaa").is_none());
    }
}
