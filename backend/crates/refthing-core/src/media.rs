//! What a media container holds, read from its track list — no decoding.
//!
//! The general sniffer (`infer`) names every Matroska/WebM, MP4/MOV and ASF
//! file a video by its container alone, though plenty hold only audio
//! (`.weba`, `.mka`, `.m4a` under an MP4 brand, `.wma`). [`tracks`] answers
//! which they are.

use std::io::{self, Read, Seek, SeekFrom};

/// Kinds of track a container declares.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tracks {
    pub audio: bool,
    pub video: bool,
}

/// Container families whose track list [`tracks`] can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    /// ISO base media: MP4, MOV, 3GP, M4A.
    Mp4,
    /// Matroska and `WebM`.
    Matroska,
    /// ASF: WMA, WMV.
    Asf,
}

impl Family {
    /// The family of a container MIME type `infer` reports as video.
    #[must_use]
    pub fn of_video_mime(mime: &str) -> Option<Self> {
        match mime {
            "video/mp4" | "video/quicktime" | "video/x-m4v" | "video/3gpp" | "video/3gpp2" => {
                Some(Self::Mp4)
            }
            "video/webm" | "video/x-matroska" => Some(Self::Matroska),
            "video/x-ms-wmv" | "video/x-ms-asf" => Some(Self::Asf),
            _ => None,
        }
    }

    /// The MIME type for an audio-only file of this family (`webm`: the
    /// sniffed type was `WebM` rather than plain Matroska).
    #[must_use]
    pub fn audio_mime(self, webm: bool) -> &'static str {
        match self {
            Self::Mp4 => "audio/mp4",
            Self::Matroska if webm => "audio/webm",
            Self::Matroska => "audio/x-matroska",
            Self::Asf => "audio/x-ms-wma",
        }
    }
}

/// A track list is never this big; a larger one is not a file to trust.
const MAX_HEADER: u64 = 16 * 1024 * 1024;

/// The kinds of track the container declares.
///
/// # Errors
/// I/O errors, or a container that doesn't parse as its family.
pub fn tracks<R: Read + Seek>(family: Family, reader: &mut R) -> io::Result<Tracks> {
    match family {
        Family::Mp4 => mp4_tracks(reader),
        Family::Matroska => matroska_tracks(reader),
        Family::Asf => asf_tracks(reader),
    }
}

fn invalid(what: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, what.to_string())
}

fn read_bounded<R: Read>(reader: &mut R, size: u64) -> io::Result<Vec<u8>> {
    if size > MAX_HEADER {
        return Err(invalid("header too large"));
    }
    let mut bytes = vec![0; usize::try_from(size).map_err(|_| invalid("header too large"))?];
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}

// ------------------------------------------------------------------ MP4

/// Walks the top-level boxes to `moov`, then reads each track's handler
/// (`hdlr`: `soun` audio, `vide` video).
fn mp4_tracks<R: Read + Seek>(reader: &mut R) -> io::Result<Tracks> {
    let end = reader.seek(SeekFrom::End(0))?;
    let mut position = 0u64;
    while position + 8 <= end {
        reader.seek(SeekFrom::Start(position))?;
        let mut header = [0u8; 8];
        reader.read_exact(&mut header)?;
        let kind = [header[4], header[5], header[6], header[7]];
        let (size, header_len) =
            match u32::from_be_bytes([header[0], header[1], header[2], header[3]]) {
                0 => (end - position, 8),
                1 => {
                    let mut large = [0u8; 8];
                    reader.read_exact(&mut large)?;
                    (u64::from_be_bytes(large), 16)
                }
                size => (u64::from(size), 8),
            };
        if size < header_len {
            return Err(invalid("bad MP4 box"));
        }
        if &kind == b"moov" {
            let body = read_bounded(reader, size - header_len)?;
            return Ok(mp4_handlers(&body));
        }
        position += size;
    }
    Ok(Tracks::default())
}

/// Every `hdlr` box in `moov`: version/flags (4), pre-defined (4), then the
/// handler type.
fn mp4_handlers(moov: &[u8]) -> Tracks {
    let mut tracks = Tracks::default();
    for index in 0..moov.len().saturating_sub(16) {
        if &moov[index..index + 4] != b"hdlr" {
            continue;
        }
        match &moov[index + 12..index + 16] {
            b"soun" => tracks.audio = true,
            b"vide" => tracks.video = true,
            _ => {}
        }
    }
    tracks
}

// ------------------------------------------------------------- Matroska

const EBML: u64 = 0x1A45_DFA3;
const SEGMENT: u64 = 0x1853_8067;
const TRACKS: u64 = 0x1654_AE6B;
const CLUSTER: u64 = 0x1F43_B675;
const TRACK_ENTRY: u64 = 0xAE;
const TRACK_TYPE: u64 = 0x83;
const UNKNOWN_SIZE: u64 = u64::MAX;

/// An EBML variable-length integer: the element ID (`id`, marker kept) or a
/// size (marker dropped; all ones means "unknown").
fn read_vint<R: Read>(reader: &mut R, id: bool) -> io::Result<u64> {
    let mut first = [0u8; 1];
    reader.read_exact(&mut first)?;
    let length = first[0].leading_zeros() as usize + 1;
    if length > 8 {
        return Err(invalid("bad EBML number"));
    }
    // The bits after the length marker (none when the number is 8 bytes).
    let mask = 0xFFu8
        .checked_shr(u32::try_from(length).unwrap_or(8))
        .unwrap_or(0);
    let mut value = u64::from(if id { first[0] } else { first[0] & mask });
    let mut all_ones = value == u64::from(mask);
    for _ in 1..length {
        let mut byte = [0u8; 1];
        reader.read_exact(&mut byte)?;
        all_ones &= byte[0] == 0xFF;
        value = (value << 8) | u64::from(byte[0]);
    }
    Ok(if !id && all_ones { UNKNOWN_SIZE } else { value })
}

/// The segment's children up to its `Tracks`, whose entries say each
/// track's type (1 video, 2 audio).
fn matroska_tracks<R: Read + Seek>(reader: &mut R) -> io::Result<Tracks> {
    reader.seek(SeekFrom::Start(0))?;
    if read_vint(reader, true)? != EBML {
        return Err(invalid("not EBML"));
    }
    let header = read_vint(reader, false)?;
    if header == UNKNOWN_SIZE {
        return Err(invalid("bad EBML header"));
    }
    reader.seek(SeekFrom::Current(
        i64::try_from(header).map_err(|_| invalid("bad size"))?,
    ))?;
    if read_vint(reader, true)? != SEGMENT {
        return Err(invalid("no Matroska segment"));
    }
    read_vint(reader, false)?; // The segment's size: its children follow.
    loop {
        let id = match read_vint(reader, true) {
            Ok(id) => id,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error),
        };
        let size = read_vint(reader, false)?;
        if id == TRACKS {
            return matroska_entries(&read_bounded(reader, size)?);
        }
        // Media started with no track list before it: nothing to tell.
        if id == CLUSTER || size == UNKNOWN_SIZE {
            break;
        }
        reader.seek(SeekFrom::Current(
            i64::try_from(size).map_err(|_| invalid("bad size"))?,
        ))?;
    }
    Ok(Tracks::default())
}

fn matroska_entries(body: &[u8]) -> io::Result<Tracks> {
    let mut tracks = Tracks::default();
    let mut cursor = io::Cursor::new(body);
    while cursor.position() < body.len() as u64 {
        let id = read_vint(&mut cursor, true)?;
        let size = read_vint(&mut cursor, false)?;
        let start = cursor.position();
        let end = start
            .checked_add(size)
            .filter(|&end| end <= body.len() as u64);
        let Some(end) = end else {
            return Err(invalid("bad track entry"));
        };
        if id == TRACK_ENTRY {
            let entry =
                &body[usize::try_from(start).unwrap_or(0)..usize::try_from(end).unwrap_or(0)];
            match matroska_track_type(entry)? {
                Some(1) => tracks.video = true,
                Some(2) => tracks.audio = true,
                _ => {}
            }
        }
        cursor.set_position(end);
    }
    Ok(tracks)
}

fn matroska_track_type(entry: &[u8]) -> io::Result<Option<u64>> {
    let mut cursor = io::Cursor::new(entry);
    while cursor.position() < entry.len() as u64 {
        let id = read_vint(&mut cursor, true)?;
        let size = read_vint(&mut cursor, false)?;
        if size > 8 && id == TRACK_TYPE {
            return Err(invalid("bad track type"));
        }
        if id == TRACK_TYPE {
            let mut value = 0u64;
            for _ in 0..size {
                let mut byte = [0u8; 1];
                cursor.read_exact(&mut byte)?;
                value = (value << 8) | u64::from(byte[0]);
            }
            return Ok(Some(value));
        }
        let next = cursor.position().saturating_add(size);
        if next > entry.len() as u64 {
            return Err(invalid("bad track entry"));
        }
        cursor.set_position(next);
    }
    Ok(None)
}

// ------------------------------------------------------------------ ASF

const ASF_HEADER: [u8; 16] = [
    0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
];
const ASF_STREAM_PROPERTIES: [u8; 16] = [
    0x91, 0x07, 0xDC, 0xB7, 0xB7, 0xA9, 0xCF, 0x11, 0x8E, 0xE6, 0x00, 0xC0, 0x0C, 0x20, 0x53, 0x65,
];
const ASF_AUDIO: [u8; 16] = [
    0x40, 0x9E, 0x69, 0xF8, 0x4D, 0x5B, 0xCF, 0x11, 0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B,
];
const ASF_VIDEO: [u8; 16] = [
    0xC0, 0xEF, 0x19, 0xBC, 0x4D, 0x5B, 0xCF, 0x11, 0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B,
];

/// The header object's Stream Properties objects: each names its stream's
/// type by GUID.
fn asf_tracks<R: Read + Seek>(reader: &mut R) -> io::Result<Tracks> {
    reader.seek(SeekFrom::Start(0))?;
    let mut header = [0u8; 30];
    reader.read_exact(&mut header)?;
    if header[..16] != ASF_HEADER {
        return Err(invalid("not ASF"));
    }
    let size = u64::from_le_bytes(header[16..24].try_into().unwrap_or_default());
    let body = read_bounded(reader, size.saturating_sub(30))?;
    let mut tracks = Tracks::default();
    let mut offset = 0usize;
    while offset + 24 <= body.len() {
        let guid = &body[offset..offset + 16];
        let object = u64::from_le_bytes(
            body[offset + 16..offset + 24]
                .try_into()
                .unwrap_or_default(),
        );
        let object = usize::try_from(object).unwrap_or(usize::MAX);
        if object < 24 {
            return Err(invalid("bad ASF object"));
        }
        if guid == ASF_STREAM_PROPERTIES && offset + 40 <= body.len() {
            match <[u8; 16]>::try_from(&body[offset + 24..offset + 40]).unwrap_or_default() {
                ASF_AUDIO => tracks.audio = true,
                ASF_VIDEO => tracks.video = true,
                _ => {}
            }
        }
        offset = offset.saturating_add(object);
    }
    Ok(tracks)
}
