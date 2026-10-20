//! Audio waveforms — an audio item's poster.
//!
//! [`decode_envelope`] decodes the file itself (Symphonia: WAV, AIFF, CAF,
//! FLAC, MP3, Ogg Vorbis, AAC/M4A, ALAC, Matroska/WebM; `rusty-opus`:
//! Opus in Ogg or `WebM` — no ffmpeg needed) into an [`Envelope`]: per bar,
//! the loudest moment and the average loudness. Any other decoder (the
//! server pipes ffmpeg's samples for WMA, AC-3, AMR …) feeds an
//! [`EnvelopeBuilder`] the same way. [`render_tile`]
//! draws `RefThing`'s waveform tile from it, which the poster pyramid then
//! scales like any image.
//!
//! The tile is board content, so it has one fixed face in both themes — the
//! file card's (frontend `CardTextureSource.ts`): the same slate, border and
//! corner radius, the waveform in the card accent.

use std::fs::File;
use std::path::Path;

use image::{Rgba, RgbaImage};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::audio::well_known::CODEC_ID_OPUS;
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;

/// The renderer's revision, stored with the derivatives it makes: posters
/// drawn by an older one (or by ffmpeg, revision 0) are redrawn, and the
/// revision is part of their URL so no cached copy shows.
pub const WAVEFORM_REV: i64 = 1;

/// The tile's size in px — the item is placed at 480×120, so this is its
/// 3⅓× master; the pyramid scales it down per zoom.
pub const TILE_WIDTH: u32 = 1600;
pub const TILE_HEIGHT: u32 = 400;
// The same, for drawing.
const TILE_W: f32 = 1600.0;
const TILE_H: f32 = 400.0;

/// Bars across the tile.
pub const BARS: usize = 110;

/// One world px of the placed item, in tile px.
const SCALE: f32 = TILE_W / 480.0;
const RADIUS: f32 = 8.0 * SCALE;
const BORDER: f32 = 1.0 * SCALE;
const PAD_X: f32 = 18.0 * SCALE;
const PAD_Y: f32 = 16.0 * SCALE;
/// Share of each bar's slot the bar fills (the rest is the gap).
const BAR_FILL: f32 = 0.6;

const FACE: [u8; 3] = [0x26, 0x2c, 0x38];
const EDGE: [u8; 3] = [0x45, 0x4c, 0x48];
const ACCENT: [u8; 3] = [0x8f, 0xb4, 0xec];
/// The loudest moment, drawn behind the solid average.
const PEAK_ALPHA: f32 = 0.38;

/// Loudness per bar, each 0..=1 of the file's loudest sample.
#[derive(Debug, Clone, PartialEq)]
pub struct Envelope {
    /// Loudest |sample| in the bar.
    pub peaks: Vec<f32>,
    /// Root-mean-square level in the bar (always ≤ its peak).
    pub rms: Vec<f32>,
}

/// Collects decoded samples into fine slices, then folds them into bars.
#[derive(Debug)]
pub struct EnvelopeBuilder {
    /// Frames per slice.
    slice: usize,
    frames: usize,
    peak: f32,
    sum_squares: f64,
    slices: Vec<(f32, f64, u32)>,
}

impl EnvelopeBuilder {
    /// `total_frames` when the container knows it (finer slices for short
    /// clips, coarser for long ones); otherwise a fixed slice.
    #[must_use]
    pub fn new(total_frames: Option<u64>) -> Self {
        let slice = total_frames.map_or(256, |total| {
            let per = total / (BARS as u64 * 8);
            usize::try_from(per.clamp(16, 8192)).unwrap_or(256)
        });
        Self {
            slice,
            frames: 0,
            peak: 0.0,
            sum_squares: 0.0,
            slices: Vec::new(),
        }
    }

    /// Interleaved samples (any channel count, nominally -1..=1). A frame's
    /// level is its loudest channel; its energy, the channels' mean.
    pub fn push_interleaved(&mut self, samples: &[f32], channels: usize) {
        let channels = channels.max(1);
        for frame in samples.chunks_exact(channels) {
            let mut loudest = 0.0f32;
            let mut energy = 0.0f64;
            for &sample in frame {
                let sample = if sample.is_finite() { sample } else { 0.0 };
                loudest = loudest.max(sample.abs());
                energy += f64::from(sample) * f64::from(sample);
            }
            self.peak = self.peak.max(loudest);
            #[allow(clippy::cast_precision_loss)] // a channel count
            let channels_f = channels as f64;
            self.sum_squares += energy / channels_f;
            self.frames += 1;
            if self.frames == self.slice {
                self.close_slice();
            }
        }
    }

    fn close_slice(&mut self) {
        if self.frames == 0 {
            return;
        }
        let frames = u32::try_from(self.frames).unwrap_or(u32::MAX);
        self.slices.push((self.peak, self.sum_squares, frames));
        self.frames = 0;
        self.peak = 0.0;
        self.sum_squares = 0.0;
    }

    /// The envelope over [`BARS`] bars, normalized to the loudest sample;
    /// `None` when nothing was decoded.
    #[must_use]
    pub fn finish(mut self) -> Option<Envelope> {
        self.close_slice();
        if self.slices.is_empty() {
            return None;
        }
        let count = self.slices.len();
        let mut peaks = Vec::with_capacity(BARS);
        let mut rms = Vec::with_capacity(BARS);
        for bar in 0..BARS {
            // Slices [start, end) — at least one, so a clip shorter than the
            // bar count repeats slices rather than leaving gaps.
            let start = bar * count / BARS;
            let end = ((bar + 1) * count / BARS).max(start + 1).min(count);
            let (mut peak, mut squares, mut frames) = (0.0f32, 0.0f64, 0u64);
            for &(slice_peak, slice_squares, slice_frames) in &self.slices[start..end] {
                peak = peak.max(slice_peak);
                squares += slice_squares;
                frames += u64::from(slice_frames);
            }
            peaks.push(peak);
            #[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
            rms.push((squares / frames.max(1) as f64).sqrt() as f32);
        }
        let loudest = peaks.iter().copied().fold(0.0f32, f32::max);
        if loudest > 0.0 {
            for value in peaks.iter_mut().chain(rms.iter_mut()) {
                *value = (*value / loudest).clamp(0.0, 1.0);
            }
        }
        Some(Envelope { peaks, rms })
    }
}

/// Decodes the file's first audio track into its envelope. `extension`
/// helps the format probe (it reads the content regardless).
///
/// # Errors
/// The file can't be opened, isn't a container Symphonia knows, or its
/// codec has no Symphonia decoder (Opus, WMA, AC-3, AMR …) — the caller
/// can try another decoder.
pub fn decode_envelope(path: &Path, extension: Option<&str>) -> Result<Envelope, DecodeError> {
    let file = File::open(path)?;
    let source = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    if let Some(extension) = extension {
        hint.with_extension(extension);
    }
    let mut format = symphonia::default::get_probe().probe(
        &hint,
        source,
        FormatOptions::default(),
        MetadataOptions::default(),
    )?;
    let track = format
        .default_track(TrackType::Audio)
        .or_else(|| format.first_track_known_codec(TrackType::Audio))
        .ok_or(DecodeError::Unsupported("no audio track"))?;
    let track_id = track.id;
    let total_frames = track.num_frames;
    let params = track
        .codec_params
        .as_ref()
        .and_then(|params| params.audio())
        .cloned()
        .ok_or(DecodeError::Unsupported("no audio codec parameters"))?;
    if params.codec == CODEC_ID_OPUS {
        return decode_opus(format.as_mut(), track_id, total_frames, &params);
    }
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&params, &AudioDecoderOptions::default())?;

    let mut builder = EnvelopeBuilder::new(total_frames);
    let mut samples: Vec<f32> = Vec::new();
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            // The end (a truncated file ends here too, with what it had).
            Ok(None) | Err(DecodeError::IoError(_) | DecodeError::ResetRequired) => break,
            // A damaged stretch: skip it.
            Err(DecodeError::DecodeError(_)) => continue,
            Err(error) => return Err(error),
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(buffer) => {
                let channels = buffer.num_planes();
                buffer.copy_to_vec_interleaved(&mut samples);
                builder.push_interleaved(&samples, channels);
            }
            Err(DecodeError::DecodeError(_) | DecodeError::IoError(_)) => {}
            Err(error) => return Err(error),
        }
    }
    builder
        .finish()
        .ok_or(DecodeError::DecodeError("no audio decoded"))
}

/// Opus output rate for a waveform: mono, and low (the decoder downmixes
/// and resamples itself).
const OPUS_RATE: i32 = 16_000;

/// Opus packets (Symphonia demuxes them from Ogg and `WebM` but has no Opus
/// decoder): decoded by `rusty-opus` to mono at [`OPUS_RATE`].
fn decode_opus(
    format: &mut dyn symphonia::core::formats::FormatReader,
    track_id: u32,
    total_frames: Option<u64>,
    params: &symphonia::core::codecs::audio::AudioCodecParameters,
) -> Result<Envelope, DecodeError> {
    // Surround Opus is several streams per packet: not this decoder's.
    if params
        .channels
        .as_ref()
        .is_some_and(|channels| channels.count() > 2)
    {
        return Err(DecodeError::Unsupported("multichannel Opus"));
    }
    let mut decoder = rusty_opus::OpusDecoder::new(OPUS_RATE, 1)
        .map_err(|_| DecodeError::Unsupported("Opus decoder"))?;
    // The container counts Opus frames at 48 kHz.
    let mut builder = EnvelopeBuilder::new(
        total_frames.map(|frames| frames * u64::from(OPUS_RATE.unsigned_abs()) / 48_000),
    );
    // The longest Opus packet: 120 ms.
    let max_frame = OPUS_RATE.unsigned_abs() as usize * 120 / 1000;
    let mut pcm = vec![0f32; max_frame];
    let mut any_audio = false;
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) | Err(DecodeError::IoError(_) | DecodeError::ResetRequired) => break,
            Err(DecodeError::DecodeError(_)) => continue,
            Err(error) => return Err(error),
        };
        if packet.track_id != track_id {
            continue;
        }
        // A damaged packet is skipped (the waveform only needs the shape).
        if let Ok(frames) = decoder.decode(&packet.data, max_frame, &mut pcm) {
            builder.push_interleaved(&pcm[..frames.min(pcm.len())], 1);
            any_audio = true;
        }
    }
    if !any_audio {
        return Err(DecodeError::DecodeError("no Opus audio decoded"));
    }
    builder
        .finish()
        .ok_or(DecodeError::DecodeError("no audio decoded"))
}

/// The audio's length in seconds from its container, without decoding;
/// `None` when the container doesn't say (or isn't one Symphonia knows).
#[must_use]
pub fn audio_duration(path: &Path, extension: Option<&str>) -> Option<f64> {
    let file = File::open(path).ok()?;
    let source = MediaSourceStream::new(Box::new(file), MediaSourceStreamOptions::default());
    let mut hint = Hint::new();
    if let Some(extension) = extension {
        hint.with_extension(extension);
    }
    let format = symphonia::default::get_probe()
        .probe(
            &hint,
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .ok()?;
    let track = format.default_track(TrackType::Audio)?;
    let frames = track.num_frames?;
    let rate = track.codec_params.as_ref()?.audio()?.sample_rate?;
    #[allow(clippy::cast_precision_loss)]
    let seconds = frames as f64 / f64::from(rate);
    (seconds.is_finite() && seconds > 0.0).then_some(seconds)
}

/// `RefThing`'s waveform tile ([`TILE_WIDTH`]×[`TILE_HEIGHT`], transparent
/// outside its rounded face): mirrored round-capped bars, the loudest moment
/// soft behind the average loudness; silence still draws a dot per bar, so
/// the timeline reads end to end.
#[must_use]
pub fn render_tile(envelope: &Envelope) -> RgbaImage {
    let (width, height) = (TILE_W, TILE_H);
    let mut tile = RgbaImage::new(TILE_WIDTH, TILE_HEIGHT);

    // The face and its border, antialiased on the rounded corners.
    for (x, y, pixel) in tile.enumerate_pixels_mut() {
        #[allow(clippy::cast_precision_loss)]
        let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
        let distance = rounded_rect_distance(px, py, width, height, RADIUS);
        let face = coverage(distance);
        if face <= 0.0 {
            continue;
        }
        let ring = coverage((distance + BORDER / 2.0).abs() - BORDER / 2.0);
        let color = mix(FACE, EDGE, ring);
        *pixel = Rgba([color[0], color[1], color[2], to_byte(face)]);
    }

    let area_width = width - 2.0 * PAD_X;
    let half_height = (height - 2.0 * PAD_Y) / 2.0;
    let center_y = height / 2.0;
    let bars = envelope.peaks.len().min(envelope.rms.len()).max(1);
    #[allow(clippy::cast_precision_loss)]
    let slot = area_width / bars as f32;
    let bar_radius = slot * BAR_FILL / 2.0;
    for (index, (&peak, &rms)) in envelope.peaks.iter().zip(&envelope.rms).enumerate() {
        #[allow(clippy::cast_precision_loss)]
        let center_x = PAD_X + slot * (index as f32 + 0.5);
        // Perceptual: quiet passages stay visible next to loud ones.
        let peak_half = (peak.sqrt() * half_height).max(bar_radius);
        let rms_half = (rms.min(peak).sqrt() * half_height).max(bar_radius);
        draw_bar(
            &mut tile, center_x, center_y, peak_half, bar_radius, PEAK_ALPHA,
        );
        draw_bar(&mut tile, center_x, center_y, rms_half, bar_radius, 1.0);
    }
    tile
}

/// A vertical capsule `half` tall each side of `center_y`, blended over the
/// face in the accent.
fn draw_bar(
    tile: &mut RgbaImage,
    center_x: f32,
    center_y: f32,
    half: f32,
    radius: f32,
    alpha: f32,
) {
    let top = (center_y - half - 1.0).floor().max(0.0);
    let bottom = (center_y + half + 1.0).ceil().min(TILE_H);
    let left = (center_x - radius - 1.0).floor().max(0.0);
    let right = (center_x + radius + 1.0).ceil().min(TILE_W);
    // The straight part of the capsule (its caps are the radius around it).
    let reach = (half - radius).max(0.0);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    for y in top as u32..bottom as u32 {
        for x in left as u32..right as u32 {
            #[allow(clippy::cast_precision_loss)]
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            let along = (py - center_y).clamp(-reach, reach);
            let distance = (px - center_x).hypot(py - center_y - along) - radius;
            let amount = coverage(distance) * alpha;
            if amount <= 0.0 {
                continue;
            }
            let pixel = tile.get_pixel_mut(x, y);
            let base = [pixel[0], pixel[1], pixel[2]];
            let blended = mix(base, ACCENT, amount);
            *pixel = Rgba([blended[0], blended[1], blended[2], pixel[3]]);
        }
    }
}

/// Signed distance from a pixel centre to a `width`×`height` rounded rect
/// at the origin (negative inside).
fn rounded_rect_distance(x: f32, y: f32, width: f32, height: f32, radius: f32) -> f32 {
    let qx = (x - width / 2.0).abs() - (width / 2.0 - radius);
    let qy = (y - height / 2.0).abs() - (height / 2.0 - radius);
    qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - radius
}

/// Pixel coverage of a shape from the signed distance at its centre.
fn coverage(distance: f32) -> f32 {
    (0.5 - distance).clamp(0.0, 1.0)
}

fn mix(base: [u8; 3], over: [u8; 3], amount: f32) -> [u8; 3] {
    let channel =
        |a: u8, b: u8| to_byte((f32::from(a) + (f32::from(b) - f32::from(a)) * amount) / 255.0);
    [
        channel(base[0], over[0]),
        channel(base[1], over[1]),
        channel(base[2], over[2]),
    ]
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn to_byte(unit: f32) -> u8 {
    (unit.clamp(0.0, 1.0) * 255.0).round() as u8
}

#[cfg(test)]
#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
mod tests {
    use super::*;

    /// A tone: silent, then loud, then quiet.
    fn shaped(rate: usize) -> Vec<f32> {
        let mut samples = Vec::new();
        for i in 0..rate * 3 {
            #[allow(clippy::cast_precision_loss)]
            let t = i as f32 / rate as f32;
            let level = if t < 1.0 {
                0.0
            } else if t < 2.0 {
                0.9
            } else {
                0.1
            };
            samples.push(level * (t * 440.0 * std::f32::consts::TAU).sin());
        }
        samples
    }

    #[test]
    fn the_envelope_follows_the_loudness_and_is_normalized() {
        let samples = shaped(8000);
        let mut builder = EnvelopeBuilder::new(Some(samples.len() as u64));
        builder.push_interleaved(&samples, 1);
        let envelope = builder.finish().expect("envelope");
        assert_eq!(envelope.peaks.len(), BARS);
        assert_eq!(envelope.rms.len(), BARS);
        let third = BARS / 3;
        assert!(envelope.peaks[third / 2] < 0.01, "silence");
        assert!(
            envelope.peaks[third + third / 2] > 0.95,
            "the loudest part is ~1"
        );
        let quiet = envelope.peaks[2 * third + third / 2];
        assert!((0.05..0.2).contains(&quiet), "quiet part {quiet}");
        for (peak, rms) in envelope.peaks.iter().zip(&envelope.rms) {
            assert!(rms <= peak);
        }
    }

    #[test]
    fn stereo_frames_take_their_loudest_channel() {
        let mut builder = EnvelopeBuilder::new(None);
        // Opposite channels would cancel in a plain average.
        let frames: Vec<f32> = (0..4096).flat_map(|_| [0.5, -0.5]).collect();
        builder.push_interleaved(&frames, 2);
        let envelope = builder.finish().expect("envelope");
        assert!(envelope.peaks.iter().all(|&peak| (peak - 1.0).abs() < 1e-6));
    }

    #[test]
    fn a_very_short_clip_still_fills_every_bar() {
        let mut builder = EnvelopeBuilder::new(Some(40));
        builder.push_interleaved(&[0.3; 40], 1);
        let envelope = builder.finish().expect("envelope");
        assert_eq!(envelope.peaks.len(), BARS);
        assert!(envelope.peaks.iter().all(|&peak| peak > 0.99));
    }

    #[test]
    fn nothing_decoded_is_no_envelope() {
        assert!(EnvelopeBuilder::new(None).finish().is_none());
    }

    #[test]
    fn the_tile_is_a_rounded_face_with_accent_bars() {
        let samples = shaped(8000);
        let mut builder = EnvelopeBuilder::new(Some(samples.len() as u64));
        builder.push_interleaved(&samples, 1);
        let tile = render_tile(&builder.finish().expect("envelope"));
        assert_eq!(tile.dimensions(), (TILE_WIDTH, TILE_HEIGHT));
        // Transparent outside the rounded corner, the face inside.
        assert_eq!(tile.get_pixel(0, 0)[3], 0);
        let face = tile.get_pixel(TILE_WIDTH / 2, 6);
        assert_eq!(
            [face[0], face[1], face[2], face[3]],
            [0x26, 0x2c, 0x38, 255]
        );
        // The loud middle third: a solid accent bar through the centre line.
        let slot = (TILE_WIDTH as f32 - 2.0 * PAD_X) / BARS as f32;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let loud_x = (PAD_X + slot * (BARS as f32 / 2.0 + 0.5)) as u32;
        let loud = tile.get_pixel(loud_x, TILE_HEIGHT / 2 - 100);
        assert_eq!([loud[0], loud[1], loud[2]], ACCENT, "loud bar");
        // The silent first third: only a dot on the centre line.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let silent_x = (PAD_X + slot * 5.5) as u32;
        let above = tile.get_pixel(silent_x, TILE_HEIGHT / 2 - 40);
        assert_eq!([above[0], above[1], above[2]], FACE, "silence is flat");
        let dot = tile.get_pixel(silent_x, TILE_HEIGHT / 2);
        assert_eq!([dot[0], dot[1], dot[2]], ACCENT, "a dot marks it");
    }
}
