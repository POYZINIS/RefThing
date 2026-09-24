//! Synchronous pyramid generation; runs inside [`ResizePool::run`].
//!
//! One decode per blob, then progressive downscale: levels are generated
//! largest-first so each smaller level resizes from the smallest already
//! produced image that is at least 2x the target (cheaper than a single-pass
//! convolution from a multi-megapixel decode, with no quality loss that
//! matters at these reduction factors).

use std::fs;
use std::path::{Path, PathBuf};

use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use image::{DynamicImage, ImageDecoder as _, ImageReader, RgbaImage};

use crate::pipeline::{DerivativeRecord, MAX_PIXELS, PipelineError, PyramidLevel};

const WEBP_FORMAT: &str = "image/webp";

/// Generates every applicable derivative level for the image at
/// `original_path`, writing `<deriv_root>/<hash[0..2]>/<hash[2..4]>/<hash>/<level>.webp`
/// files atomically (`.tmp` + rename) and returning one record per file.
///
/// Levels at or above the original's longest edge are skipped (never
/// upscale); the DB layer records those as aliases of the original bytes.
/// Re-running for an already-generated level is a no-op: an existing
/// destination is complete by construction (same hash ⇒ same content).
///
/// # Errors
/// Returns [`PipelineError`] when the file cannot be read, fails to decode,
/// exceeds the [`MAX_PIXELS`] safety limit, or when resize/encode/write
/// fails.
pub fn generate_pyramid(
    original_path: &Path,
    blob_hash: &str,
    deriv_root: &Path,
) -> Result<Vec<DerivativeRecord>, PipelineError> {
    let decoded = decode_normalized(original_path)?;
    let (orig_w, orig_h) = (decoded.width(), decoded.height());
    let orig_max = orig_w.max(orig_h);

    let mut records = Vec::new();
    // Produced level images, descending by size, as downscale sources.
    let mut produced: Vec<RgbaImage> = Vec::new();
    for level in PyramidLevel::ALL.into_iter().rev() {
        if orig_max <= level.max_edge() {
            continue; // never upscale; this level aliases `full`
        }
        let (dst_w, dst_h) = fit_within(orig_w, orig_h, level.max_edge());
        let source = best_source(&decoded, &produced, dst_w.max(dst_h));
        let resized = resize_level(source, dst_w, dst_h)?;
        let bytes = encode_webp(&resized, level.quality())?;
        let rel_path = derivative_rel_path(blob_hash, level);
        write_atomic(&deriv_root.join(&rel_path), &bytes)?;
        records.push(DerivativeRecord {
            level,
            width: dst_w,
            height: dst_h,
            byte_size: bytes.len() as u64,
            format: WEBP_FORMAT.to_string(),
            rel_path,
        });
        produced.push(resized);
    }
    records.sort_by_key(|record| record.level.max_edge());
    Ok(records)
}

/// Decodes `path` to 8-bit RGBA with EXIF orientation applied. Animated
/// formats (GIF) contribute their first frame only. Color profiles are
/// ignored (v1; documented minor color-shift risk on wide-gamut sources).
pub(crate) fn decode_normalized(path: &Path) -> Result<RgbaImage, PipelineError> {
    let mut reader = ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_PIXELS.saturating_mul(4)); // worst case RGBA8
    reader.limits(limits);

    let mut decoder = reader.into_decoder()?;
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);

    let rgba = image.to_rgba8();
    let pixels = u64::from(rgba.width()) * u64::from(rgba.height());
    if pixels > MAX_PIXELS {
        return Err(PipelineError::TooLarge {
            width: rgba.width(),
            height: rgba.height(),
        });
    }
    Ok(rgba)
}

/// Picks the downscale source for a target whose longest edge is
/// `target_max`: the smallest already-produced image at least 2x the target,
/// else the full decode.
fn best_source<'a>(
    decoded: &'a RgbaImage,
    produced: &'a [RgbaImage],
    target_max: u32,
) -> &'a RgbaImage {
    produced
        .iter()
        .filter(|image| image.width().max(image.height()) >= 2 * target_max)
        .min_by_key(|image| image.width().max(image.height()))
        .unwrap_or(decoded)
}

/// Dimensions of `width`x`height` scaled to fit within `max_edge` on the
/// longest edge, aspect ratio preserved, never below 1px.
fn fit_within(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_edge {
        return (width, height);
    }
    let scale = |dim: u32| -> u32 {
        // (dim * max_edge / longest), rounded to nearest, via integer math.
        let scaled =
            (u64::from(dim) * u64::from(max_edge) + u64::from(longest) / 2) / u64::from(longest);
        u32::try_from(scaled).unwrap_or(1).max(1)
    };
    (scale(width), scale(height))
}

/// Lanczos3 downscale via `fast_image_resize`; alpha premultiply/divide for
/// `U8x4` is automatic, so transparency survives without fringe artifacts.
fn resize_level(src: &RgbaImage, dst_w: u32, dst_h: u32) -> Result<RgbaImage, PipelineError> {
    let src_view = ImageRef::new(src.width(), src.height(), src.as_raw(), PixelType::U8x4)
        .map_err(|error| PipelineError::Resize(error.to_string()))?;
    let mut dst = Image::new(dst_w, dst_h, PixelType::U8x4);
    let options = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3));
    Resizer::new()
        .resize(&src_view, &mut dst, Some(&options))
        .map_err(|error| PipelineError::Resize(error.to_string()))?;
    RgbaImage::from_raw(dst.width(), dst.height(), dst.into_vec())
        .ok_or_else(|| PipelineError::Resize("resized buffer size mismatch".to_string()))
}

/// Lossy WebP at the level's quality. The `image` crate's encoder is
/// lossless-only, so this goes through libwebp.
fn encode_webp(image: &RgbaImage, quality: f32) -> Result<Vec<u8>, PipelineError> {
    let encoder = webp::Encoder::from_rgba(image.as_raw(), image.width(), image.height());
    let memory = encoder
        .encode_simple(false, quality)
        .map_err(|error| PipelineError::WebpEncode(format!("{error:?}")))?;
    Ok(memory.to_vec())
}

/// `<hash[0..2]>/<hash[2..4]>/<hash>/<level>.webp`, matching the blob store's
/// two-level sharding. A hash shorter than 4 chars (caller garbage) lands
/// unsharded instead of panicking on the slice.
fn derivative_rel_path(blob_hash: &str, level: PyramidLevel) -> PathBuf {
    let mut path = PathBuf::new();
    if let (Some(first), Some(second)) = (blob_hash.get(0..2), blob_hash.get(2..4)) {
        path.push(first);
        path.push(second);
    }
    path.push(blob_hash);
    path.push(format!("{}.webp", level.as_str()));
    path
}

/// Writes `bytes` to `path` via a sibling `.tmp` file + rename, so a crash
/// can never leave a truncated derivative at its canonical path. An existing
/// `path` means the level is already generated (content is deterministic):
/// the write is skipped. On Windows rename-over-existing fails, so a lost
/// rename race with `path` now present is also treated as success.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), PipelineError> {
    if fs::exists(path)? {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp_path = path.with_extension("webp.tmp");
    fs::write(&tmp_path, bytes)?;
    match fs::rename(&tmp_path, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&tmp_path);
            if fs::exists(path).unwrap_or(false) {
                Ok(())
            } else {
                Err(error.into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use image::codecs::gif::GifEncoder;
    use image::{Rgb, RgbImage, Rgba};

    use super::*;

    const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn gradient_rgb(width: u32, height: u32) -> RgbImage {
        RgbImage::from_fn(width, height, |x, y| {
            #[allow(clippy::cast_possible_truncation)]
            Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 211) as u8])
        })
    }

    fn webp_dimensions(bytes: &[u8]) -> (u32, u32) {
        let decoded = webp::Decoder::new(bytes).decode().expect("decode webp");
        (decoded.width(), decoded.height())
    }
    fn assert_record(record: &DerivativeRecord, root: &Path, level: PyramidLevel, w: u32, h: u32) {
        assert_eq!(record.level, level);
        assert_eq!((record.width, record.height), (w, h));
        assert_eq!(record.format, WEBP_FORMAT);
        assert!(record.byte_size > 0);
        let file = root.join(&record.rel_path);
        assert!(file.is_file(), "missing {}", file.display());
        assert_eq!(fs::metadata(&file).expect("stat").len(), record.byte_size);
        let bytes = fs::read(&file).expect("read derivative");
        assert_eq!(webp_dimensions(&bytes), (w, h));
    }

    #[test]
    fn large_rgb_png_produces_all_three_levels() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("source.png");
        gradient_rgb(2400, 1600).save(&source).expect("write png");
        let deriv_root = dir.path().join("deriv");

        let records = generate_pyramid(&source, HASH, &deriv_root).expect("generate");
        assert_eq!(
            records.iter().map(|r| r.level).collect::<Vec<_>>(),
            vec![
                PyramidLevel::Thumb,
                PyramidLevel::Small,
                PyramidLevel::Medium
            ]
        );
        assert_record(&records[0], &deriv_root, PyramidLevel::Thumb, 64, 43);
        assert_record(&records[1], &deriv_root, PyramidLevel::Small, 256, 171);
        assert_record(&records[2], &deriv_root, PyramidLevel::Medium, 1024, 683);

        // Shard layout: <hash[0..2]>/<hash[2..4]>/<hash>/<level>.webp.
        assert_eq!(
            records[0].rel_path,
            Path::new("01").join("23").join(HASH).join("thumb.webp")
        );

        // Idempotent: a second run skips existing files and succeeds.
        let again = generate_pyramid(&source, HASH, &deriv_root).expect("regenerate");
        assert_eq!(records, again);
    }

    #[test]
    fn small_image_skips_levels_at_or_above_the_original() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("small.png");
        gradient_rgb(200, 200).save(&source).expect("write png");
        let deriv_root = dir.path().join("deriv");

        let records = generate_pyramid(&source, HASH, &deriv_root).expect("generate");
        assert_eq!(records.len(), 1);
        assert_record(&records[0], &deriv_root, PyramidLevel::Thumb, 64, 64);
    }

    #[test]
    fn thumbnail_sized_image_produces_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("tiny.png");
        gradient_rgb(64, 48).save(&source).expect("write png");

        let records = generate_pyramid(&source, HASH, dir.path()).expect("generate");
        assert!(records.is_empty());
    }

    #[test]
    fn sixteen_bit_png_is_normalized_to_rgba8() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("deep.png");
        let image: image::ImageBuffer<image::Luma<u16>, Vec<u16>> =
            image::ImageBuffer::from_pixel(300, 300, image::Luma([40_000u16]));
        image.save(&source).expect("write 16-bit png");

        let records = generate_pyramid(&source, HASH, dir.path()).expect("generate");
        assert_eq!(records.len(), 2);
        assert_record(&records[0], dir.path(), PyramidLevel::Thumb, 64, 64);
        assert_record(&records[1], dir.path(), PyramidLevel::Small, 256, 256);
    }

    #[test]
    fn animated_gif_uses_only_the_first_frame() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("anim.gif");
        let frame0 = RgbaImage::from_pixel(300, 200, Rgba([220, 20, 20, 255]));
        let frame1 = RgbaImage::from_pixel(300, 200, Rgba([20, 20, 220, 255]));
        {
            let file = fs::File::create(&source).expect("create gif");
            let mut encoder = GifEncoder::new(file);
            encoder
                .encode_frames(vec![image::Frame::new(frame0), image::Frame::new(frame1)])
                .expect("encode gif");
        }

        let records = generate_pyramid(&source, HASH, dir.path()).expect("generate");
        assert_eq!(records.len(), 2);
        assert_record(&records[0], dir.path(), PyramidLevel::Thumb, 64, 43);
        assert_record(&records[1], dir.path(), PyramidLevel::Small, 256, 171);

        // Frame 0 is red; frame 1 is blue. Lossy q72 keeps the hue dominant.
        let bytes = fs::read(dir.path().join(&records[0].rel_path)).expect("read thumb");
        let decoded = webp::Decoder::new(&bytes).decode().expect("decode thumb");
        let pixel = decoded.to_image().to_rgba8();
        let median = pixel.get_pixel(32, 21).0;
        assert!(
            median[0] > 128 && median[2] < 128,
            "expected red-ish thumb, got {median:?}"
        );
    }

    #[test]
    fn exif_orientation_is_applied_before_sizing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("rotated.jpg");
        fs::write(&source, jpeg_with_orientation6(200, 100)).expect("write jpeg");

        // Orientation 6 = rotate 90 CW: the stored 200x100 image is 100x200
        // once oriented, so the thumb fits 64 on the height, not the width.
        let records = generate_pyramid(&source, HASH, dir.path()).expect("generate");
        assert_eq!(records.len(), 1);
        assert_record(&records[0], dir.path(), PyramidLevel::Thumb, 32, 64);
    }

    #[test]
    fn corrupt_input_is_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = dir.path().join("junk.bin");
        fs::write(&source, b"this is not an image").expect("write junk");
        assert!(generate_pyramid(&source, HASH, dir.path()).is_err());
    }

    #[test]
    fn fit_within_scales_and_never_upscales_or_zeroes() {
        assert_eq!(fit_within(2400, 1600, 1024), (1024, 683));
        assert_eq!(fit_within(200, 200, 256), (200, 200));
        assert_eq!(fit_within(10_000, 1, 64), (64, 1));
        assert_eq!(fit_within(100, 200, 64), (32, 64));
    }

    /// Builds a JPEG whose EXIF declares orientation 6 (rotate 90 CW) by
    /// splicing a hand-rolled APP1 segment in after the SOI marker.
    fn jpeg_with_orientation6(width: u32, height: u32) -> Vec<u8> {
        let image = gradient_rgb(width, height);
        let mut jpeg = Vec::new();
        image
            .write_with_encoder(image::codecs::jpeg::JpegEncoder::new(&mut jpeg))
            .expect("encode jpeg");
        assert_eq!(&jpeg[0..2], &[0xFF, 0xD8], "expected SOI marker");

        let mut app1: Vec<u8> = vec![0xFF, 0xE1, 0x00, 0x00]; // length patched below
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(b"II\x2A\x00"); // little-endian TIFF
        app1.extend_from_slice(&8u32.to_le_bytes()); // IFD0 offset
        app1.extend_from_slice(&1u16.to_le_bytes()); // one entry
        app1.extend_from_slice(&0x0112u16.to_le_bytes()); // Orientation tag
        app1.extend_from_slice(&3u16.to_le_bytes()); // type SHORT
        app1.extend_from_slice(&1u32.to_le_bytes()); // count 1
        app1.extend_from_slice(&6u16.to_le_bytes()); // value 6
        app1.extend_from_slice(&0u16.to_le_bytes()); // value padding
        app1.extend_from_slice(&0u32.to_le_bytes()); // no next IFD
        let segment_len = u16::try_from(app1.len() - 2).expect("segment fits u16");
        app1[2..4].copy_from_slice(&segment_len.to_be_bytes());

        let mut out = Vec::with_capacity(jpeg.len() + app1.len());
        out.extend_from_slice(&jpeg[0..2]);
        out.extend_from_slice(&app1);
        out.extend_from_slice(&jpeg[2..]);
        out
    }
}
