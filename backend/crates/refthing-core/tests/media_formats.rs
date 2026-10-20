//! Audio across its common formats (fixtures: 0.3 s of a 440 Hz tone, made
//! with ffmpeg): decoded natively for waveforms, and told apart from video
//! by its container's track list.

use std::fs::File;
use std::path::PathBuf;

use refthing_core::media::{Family, Tracks, tracks};
use refthing_core::pipeline::waveform::{BARS, audio_duration, decode_envelope};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/media")
        .join(name)
}

#[test]
fn common_formats_decode_without_ffmpeg() {
    for name in [
        "tone.wav",
        "tone.aiff",
        "tone.caf",
        "tone.flac",
        "tone.mp3",
        "tone.ogg",
        "tone.m4a",
        "tone-audio-only.mp4",
        "tone.mka",
        // Opus: Ogg (voice notes) and WebM.
        "tone-opus.ogg",
        "tone.weba",
    ] {
        let extension = name.rsplit('.').next();
        let envelope = decode_envelope(&fixture(name), extension)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(envelope.peaks.len(), BARS, "{name}");
        // A steady tone: loud across the middle of the clip.
        assert!(
            envelope.peaks[BARS / 2] > 0.5,
            "{name}: {:?}",
            envelope.peaks[BARS / 2]
        );
        assert!(
            envelope.rms[BARS / 2] > 0.3 && envelope.rms[BARS / 2] <= envelope.peaks[BARS / 2],
            "{name}"
        );
    }
}

#[test]
fn codecs_without_a_native_decoder_say_so() {
    // WMA (also AC-3, AMR): the server takes ffmpeg's samples instead.
    assert!(decode_envelope(&fixture("tone.wma"), None).is_err());
}

#[test]
fn the_container_gives_the_length() {
    let seconds = audio_duration(&fixture("tone.wav"), Some("wav")).expect("duration");
    assert!((seconds - 0.3).abs() < 0.01, "{seconds}");
}

#[test]
fn track_lists_tell_audio_from_video() {
    let read = |family, name: &str| {
        tracks(family, &mut File::open(fixture(name)).expect(name))
            .unwrap_or_else(|error| panic!("{name}: {error}"))
    };
    let audio_only = Tracks {
        audio: true,
        video: false,
    };
    let both = Tracks {
        audio: true,
        video: true,
    };
    assert_eq!(read(Family::Matroska, "tone.weba"), audio_only);
    assert_eq!(read(Family::Matroska, "tone.mka"), audio_only);
    assert_eq!(read(Family::Mp4, "tone.m4a"), audio_only);
    assert_eq!(read(Family::Mp4, "tone-audio-only.mp4"), audio_only);
    assert_eq!(read(Family::Asf, "tone.wma"), audio_only);
    assert_eq!(
        read(Family::Matroska, "clip.webm"),
        Tracks {
            audio: false,
            video: true
        }
    );
    assert_eq!(read(Family::Mp4, "clip.mp4"), both);
    assert_eq!(read(Family::Asf, "clip.wmv"), both);
}

#[test]
fn a_file_of_the_wrong_family_is_an_error_not_a_guess() {
    assert!(tracks(Family::Asf, &mut File::open(fixture("tone.mka")).unwrap()).is_err());
    assert!(
        tracks(
            Family::Matroska,
            &mut File::open(fixture("tone.wma")).unwrap()
        )
        .is_err()
    );
}
