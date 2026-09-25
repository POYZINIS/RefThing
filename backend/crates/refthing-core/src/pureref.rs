//! `PureRef` 2.x (`.pur`) reader: turns a board file into `RefThing`-shaped
//! placements. Import only — nothing here writes a `.pur`.
//!
//! Format (reverse-engineered by github.com/FyorDev/pur-2-file-format,
//! `FORMAT.md`; checked against real `PureRef` 2.1.3 boards): a big-endian Qt
//! header — format version (`QString`), reserved `u32`, `u64` N, app version,
//! MD5 checksum (`QString`s), thumbnail (`QByteArray`, absent in format 2.0)
//! — then a `SQLite` database whose first H bytes (H = header length) were
//! moved to the end of the file:
//!
//! ```text
//! file     = [header: H bytes][db[H..N]][db[0..H]]
//! database = file[N..] + file[H..N]
//! ```
//!
//! Items form a tree (`items.parent`, -1 = root) of `QTransform`s relative to
//! their parent. Image instances map image pixels to item space through
//! `image_transform`, clipped by `image_bounds` (a `QPainterPath`). Qt values
//! are stored as `QVariant` streams; `PureRef` writes some of them into TEXT
//! columns one Latin-1 character per byte, so both storage forms decode here.

use std::fmt::Write as _;
use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};

use crate::error::CoreError;

/// `RefThing`'s note text size (world px) — `frontend/src/canvas/nodes/noteText.ts`.
const REFTHING_NOTE_FONT_PX: f64 = 15.0;
const REFTHING_NOTE_LINE_PX: f64 = 21.0;
const REFTHING_NOTE_INSET_PX: f64 = 13.0;
/// `PureRef`'s note font size when the HTML names none.
const PUREREF_DEFAULT_FONT_PX: f64 = 22.0;

// ------------------------------------------------------------- container --

/// The `.pur` header fields that matter to an import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub format_version: String,
    pub app_version: String,
    /// Bytes before the displaced database: where `db[H..N]` starts.
    pub header_len: usize,
    /// Length of the original database (N).
    pub db_len: usize,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::InvalidInput(message.into())
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], CoreError> {
        let end = self
            .pos
            .checked_add(n)
            .filter(|end| *end <= self.data.len())
            .ok_or_else(|| invalid("truncated PureRef data"))?;
        let bytes = &self.data[self.pos..end];
        self.pos = end;
        Ok(bytes)
    }

    fn u32(&mut self) -> Result<u32, CoreError> {
        let bytes: [u8; 4] = self.take(4)?.try_into().expect("4 bytes");
        Ok(u32::from_be_bytes(bytes))
    }

    fn i32(&mut self) -> Result<i32, CoreError> {
        let bytes: [u8; 4] = self.take(4)?.try_into().expect("4 bytes");
        Ok(i32::from_be_bytes(bytes))
    }

    fn u64(&mut self) -> Result<u64, CoreError> {
        let bytes: [u8; 8] = self.take(8)?.try_into().expect("8 bytes");
        Ok(u64::from_be_bytes(bytes))
    }

    fn f64(&mut self) -> Result<f64, CoreError> {
        let bytes: [u8; 8] = self.take(8)?.try_into().expect("8 bytes");
        Ok(f64::from_be_bytes(bytes))
    }

    /// Qt `QString`: u32 byte length (0xFFFFFFFF = null), UTF-16BE.
    fn qstring(&mut self) -> Result<String, CoreError> {
        let len = self.u32()?;
        if len == u32::MAX {
            return Ok(String::new());
        }
        let bytes = self.take(len as usize)?;
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_be_bytes(*pair))
            .collect();
        String::from_utf16(&units).map_err(|_| invalid("bad UTF-16 in PureRef header"))
    }
}

/// Parses the header and returns it with the reassembled `SQLite` database.
pub fn split_container(file: &[u8]) -> Result<(Header, Vec<u8>), CoreError> {
    let mut cursor = Cursor { data: file, pos: 0 };
    let format_version = cursor
        .qstring()
        .map_err(|_| invalid("this is not a PureRef board file"))?;
    let looks_like_version = !format_version.is_empty()
        && format_version.len() <= 8
        && format_version
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.');
    if !looks_like_version {
        return Err(invalid("this is not a PureRef board file"));
    }
    if !format_version.starts_with("2.") {
        return Err(invalid(format!(
            "boards saved by PureRef {format_version} are not supported yet: open it in              PureRef 2 and save it again"
        )));
    }
    cursor.u32()?; // reserved
    let db_len = usize::try_from(cursor.u64()?).map_err(|_| invalid("bad database length"))?;
    let app_version = cursor.qstring()?;
    cursor.qstring()?; // file checksum (MD5 hex)
    if format_version != "2.0" {
        let thumbnail = cursor.u32()? as usize;
        cursor.take(thumbnail)?;
    }
    let header_len = cursor.pos;
    if db_len > file.len() || header_len > db_len || file.len() - db_len != header_len {
        return Err(invalid("PureRef container lengths do not add up"));
    }
    let mut database = Vec::with_capacity(db_len);
    database.extend_from_slice(&file[db_len..]);
    database.extend_from_slice(&file[header_len..db_len]);
    if !database.starts_with(b"SQLite format 3\0") {
        return Err(invalid("no board database inside this PureRef file"));
    }
    Ok((
        Header {
            format_version,
            app_version,
            header_len,
            db_len,
        },
        database,
    ))
}

// ------------------------------------------------------------- Qt values --

/// A stored Qt value's bytes: raw for a BLOB column, one Latin-1 char per
/// byte for a TEXT column (how `PureRef` 2.1 writes them).
#[must_use]
pub fn qt_bytes(stored_type: &str, raw: &[u8]) -> Vec<u8> {
    if stored_type != "text" {
        return raw.to_vec();
    }
    match std::str::from_utf8(raw) {
        Ok(text) if text.chars().all(|c| u32::from(c) <= 0xFF) => text
            .chars()
            .map(|c| u8::try_from(u32::from(c)).unwrap_or(0))
            .collect(),
        _ => raw.to_vec(),
    }
}

/// Affine transform in Qt's row-vector convention:
/// `x' = m11*x + m21*y + dx`, `y' = m12*x + m22*y + dy`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform {
    pub m11: f64,
    pub m12: f64,
    pub m21: f64,
    pub m22: f64,
    pub dx: f64,
    pub dy: f64,
}

impl Transform {
    pub const IDENTITY: Self = Self {
        m11: 1.0,
        m12: 0.0,
        m21: 0.0,
        m22: 1.0,
        dx: 0.0,
        dy: 0.0,
    };

    /// `self` first, then `then` (a child's local transform, then its parent's).
    #[must_use]
    pub fn then(&self, then: &Self) -> Self {
        Self {
            m11: self.m11 * then.m11 + self.m12 * then.m21,
            m12: self.m11 * then.m12 + self.m12 * then.m22,
            m21: self.m21 * then.m11 + self.m22 * then.m21,
            m22: self.m21 * then.m12 + self.m22 * then.m22,
            dx: self.dx * then.m11 + self.dy * then.m21 + then.dx,
            dy: self.dx * then.m12 + self.dy * then.m22 + then.dy,
        }
    }

    #[must_use]
    pub fn map(&self, x: f64, y: f64) -> (f64, f64) {
        (
            self.m11 * x + self.m21 * y + self.dx,
            self.m12 * x + self.m22 * y + self.dy,
        )
    }

    #[must_use]
    pub fn inverse(&self) -> Option<Self> {
        let det = self.m11 * self.m22 - self.m12 * self.m21;
        if det.abs() < 1e-12 {
            return None;
        }
        let (a, b, c, d) = (
            self.m22 / det,
            -self.m12 / det,
            -self.m21 / det,
            self.m11 / det,
        );
        Some(Self {
            m11: a,
            m12: b,
            m21: c,
            m22: d,
            dx: -(self.dx * a + self.dy * c),
            dy: -(self.dx * b + self.dy * d),
        })
    }
}

/// Skips a `QVariant` header; returns the type id.
fn variant_header(cursor: &mut Cursor<'_>) -> Result<u32, CoreError> {
    let type_id = cursor.u32()?;
    cursor.take(1)?; // is_null
    if type_id == 1024 {
        let name_len = cursor.u32()? as usize; // registered type name, NUL included
        cursor.take(name_len)?;
    }
    Ok(type_id)
}

/// `QVariant(QTransform)`: nine doubles, m13/m23/m33 ignored (affine only).
pub fn decode_transform(bytes: &[u8]) -> Result<Transform, CoreError> {
    let mut cursor = Cursor {
        data: bytes,
        pos: 0,
    };
    if variant_header(&mut cursor)? != 80 {
        return Err(invalid("expected a QTransform"));
    }
    let mut m = [0.0; 9];
    for value in &mut m {
        *value = cursor.f64()?;
    }
    Ok(Transform {
        m11: m[0],
        m12: m[1],
        m21: m[3],
        m22: m[4],
        dx: m[6],
        dy: m[7],
    })
}

/// `QVariant(QPainterPath)` → its points (curves reduced to their control
/// points, enough for a bounding box).
pub fn decode_path(bytes: &[u8]) -> Result<Vec<(f64, f64)>, CoreError> {
    let mut cursor = Cursor {
        data: bytes,
        pos: 0,
    };
    variant_header(&mut cursor)?;
    let count = cursor.u32()?;
    let mut points = Vec::with_capacity(count.min(10_000) as usize);
    for _ in 0..count {
        cursor.i32()?; // element type
        points.push((cursor.f64()?, cursor.f64()?));
    }
    Ok(points)
}

/// `QVariant(QSizeF)`; `(-1, -1)` = automatic size.
pub fn decode_size(bytes: &[u8]) -> Result<(f64, f64), CoreError> {
    let mut cursor = Cursor {
        data: bytes,
        pos: 0,
    };
    if variant_header(&mut cursor)? != 22 {
        return Err(invalid("expected a QSizeF"));
    }
    Ok((cursor.f64()?, cursor.f64()?))
}

// -------------------------------------------------------------- geometry --

/// Where an image lands on a `RefThing` board: the frame (top-left, size,
/// clockwise rotation in degrees about its centre), mirror, and the crop as
/// fractions of the source image.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImagePlacement {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub flip_x: bool,
    /// `(x, y, w, h)`; `None` when the whole image shows.
    pub crop: Option<(f64, f64, f64, f64)>,
}

/// Places an image of `width × height` px whose pixels map to world space
/// through `image_to_item` then `item_to_world`, clipped (in item space) by
/// `clip` when given.
pub fn place_image(
    width: f64,
    height: f64,
    image_to_item: &Transform,
    item_to_world: &Transform,
    clip: &[(f64, f64)],
) -> Option<ImagePlacement> {
    if !(width > 0.0 && height > 0.0) {
        return None;
    }
    let to_world = image_to_item.then(item_to_world);
    // The visible region, back in image pixels, clamped to the image.
    let (mut x0, mut y0, mut x1, mut y1) = (0.0, 0.0, width, height);
    if clip.len() >= 2
        && let Some(inverse) = image_to_item.inverse()
    {
        let pixels: Vec<(f64, f64)> = clip.iter().map(|&(x, y)| inverse.map(x, y)).collect();
        x0 = pixels
            .iter()
            .map(|p| p.0)
            .fold(f64::INFINITY, f64::min)
            .max(0.0);
        y0 = pixels
            .iter()
            .map(|p| p.1)
            .fold(f64::INFINITY, f64::min)
            .max(0.0);
        x1 = pixels
            .iter()
            .map(|p| p.0)
            .fold(f64::NEG_INFINITY, f64::max)
            .min(width);
        y1 = pixels
            .iter()
            .map(|p| p.1)
            .fold(f64::NEG_INFINITY, f64::max)
            .min(height);
        if x1 - x0 < 0.5 || y1 - y0 < 0.5 {
            return None;
        }
    }
    let scale_x = to_world.m11.hypot(to_world.m12);
    let scale_y = to_world.m21.hypot(to_world.m22);
    let flip_x = to_world.m11 * to_world.m22 - to_world.m12 * to_world.m21 < 0.0;
    // The image's y axis carries the rotation unmirrored.
    let rotation = (-to_world.m21).atan2(to_world.m22).to_degrees();
    let (center_x, center_y) = to_world.map(f64::midpoint(x0, x1), f64::midpoint(y0, y1));
    let frame_width = (x1 - x0) * scale_x;
    let frame_height = (y1 - y0) * scale_y;
    let whole = x0 <= 0.5 && y0 <= 0.5 && x1 >= width - 0.5 && y1 >= height - 0.5;
    Some(ImagePlacement {
        x: center_x - frame_width / 2.0,
        y: center_y - frame_height / 2.0,
        width: frame_width,
        height: frame_height,
        rotation: if rotation.abs() < 1e-6 { 0.0 } else { rotation },
        flip_x,
        crop: (!whole).then(|| {
            (
                x0 / width,
                y0 / height,
                (x1 - x0) / width,
                (y1 - y0) / height,
            )
        }),
    })
}

// ----------------------------------------------------------------- notes --

/// Plain text of a `PureRef` note's Qt rich-text HTML, and its font size.
pub fn note_text(html: &str) -> (String, f64) {
    let font_px = html
        .find("font-size:")
        .and_then(|at| {
            let rest = html[at + "font-size:".len()..].trim_start();
            let digits: String = rest
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            let value: f64 = digits.parse().ok()?;
            Some(if rest[digits.len()..].starts_with("pt") {
                value * 4.0 / 3.0
            } else {
                value
            })
        })
        .unwrap_or(PUREREF_DEFAULT_FONT_PX);
    let body = html.find("<body").map_or(html, |at| &html[at..]);
    let mut text = String::new();
    let mut rest = body;
    while let Some(open) = rest.find('<') {
        text.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('>') else {
            break;
        };
        let tag = rest[open + 1..open + close]
            .trim_start_matches('/')
            .to_ascii_lowercase();
        let name: String = tag
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect();
        if matches!(name.as_str(), "br")
            || (rest[open + 1..].starts_with('/') && matches!(name.as_str(), "p" | "li" | "div"))
        {
            text.push('\n');
        }
        rest = &rest[open + close + 1..];
    }
    text.push_str(rest);
    let decoded = decode_entities(&text);
    let lines: Vec<&str> = decoded.lines().map(str::trim_end).collect();
    (lines.join("\n").trim().to_string(), font_px)
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let Some(end) = tail.find(';').filter(|end| *end <= 10) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix("#x")
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                .and_then(char::from_u32),
        };
        if let Some(c) = decoded {
            out.push(c);
            rest = &tail[end + 1..];
        } else {
            out.push('&');
            rest = &tail[1..];
        }
    }
    out.push_str(rest);
    out
}

/// A note as `RefThing` draws it: world frame plus a text `scale` (`RefThing`
/// text is 15 world px × scale).
#[derive(Debug, Clone, PartialEq)]
pub struct NotePlacement {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub rotation: f64,
    pub scale: f64,
    pub text: String,
}

/// Places a note whose local origin is its top-left corner. `fixed` is
/// `PureRef`'s fixed size (item space) or `None` for automatic, in which case
/// the frame is estimated from the text.
#[must_use]
pub fn place_note(
    text: String,
    font_px: f64,
    fixed: Option<(f64, f64)>,
    to_world: &Transform,
) -> NotePlacement {
    let item_scale = to_world.m11.hypot(to_world.m12).max(1e-6);
    let scale = (font_px * item_scale / REFTHING_NOTE_FONT_PX).clamp(0.05, 200.0);
    let rotation = (-to_world.m21).atan2(to_world.m22).to_degrees();
    let (width, height) = match fixed {
        Some((w, h)) if w > 0.0 && h > 0.0 => (w * item_scale, h * item_scale),
        _ => {
            // Automatic: size to the text (≈0.6 em per character; generous
            // so a label never wraps), in RefThing's own note metrics.
            let lines = text.lines().count().max(1);
            let longest = text
                .lines()
                .map(|line| line.chars().count())
                .max()
                .unwrap_or(0)
                .max(4);
            let inner =
                f64::from(u32::try_from(longest).unwrap_or(u32::MAX)) * 0.6 * REFTHING_NOTE_FONT_PX;
            (
                (inner + 2.0 * REFTHING_NOTE_INSET_PX + 6.0) * scale,
                (f64::from(u32::try_from(lines).unwrap_or(u32::MAX)) * REFTHING_NOTE_LINE_PX
                    + 2.0 * REFTHING_NOTE_INSET_PX)
                    * scale,
            )
        }
    };
    let (center_x, center_y) = to_world.map(width / item_scale / 2.0, height / item_scale / 2.0);
    NotePlacement {
        x: center_x - width / 2.0,
        y: center_y - height / 2.0,
        width,
        height,
        rotation: if rotation.abs() < 1e-6 { 0.0 } else { rotation },
        scale,
        text,
    }
}

/// `#AARRGGBB` / `#RRGGBB` → (`#rrggbb`, alpha 0–1).
#[must_use]
pub fn note_color(value: &str) -> Option<(String, f64)> {
    let hex = value.trim().strip_prefix('#')?;
    let (alpha, rgb) = match hex.len() {
        8 => (u8::from_str_radix(&hex[..2], 16).ok()?, &hex[2..]),
        6 => (255, hex),
        _ => return None,
    };
    u32::from_str_radix(rgb, 16).ok()?;
    Some((
        format!("#{}", rgb.to_ascii_lowercase()),
        f64::from(alpha) / 255.0,
    ))
}

// ----------------------------------------------------------------- board --

/// One embedded image resource (shared by every instance that shows it).
#[derive(Debug, Clone)]
pub struct Resource {
    pub id: i64,
    pub bytes: Vec<u8>,
    /// A filename for the blob, from the original path or URL.
    pub filename: String,
}

/// Something to put on the board, in `PureRef`'s paint order.
#[derive(Debug, Clone)]
pub enum Placed {
    Image {
        resource: i64,
        placement: ImagePlacement,
        opacity: f64,
    },
    Note {
        placement: NotePlacement,
        bg_color: Option<String>,
        opacity: f64,
    },
}

/// A whole `PureRef` board, ready to commit.
#[derive(Debug, Clone, Default)]
pub struct Board {
    pub app_version: String,
    pub resources: Vec<Resource>,
    /// Back to front.
    pub placed: Vec<Placed>,
    /// What could not come across (linked images, drawings, …), for the user.
    pub skipped: Vec<String>,
}

fn filename_from(origin: Option<&str>, format: Option<&str>, id: i64) -> String {
    let ext = match format.unwrap_or("").to_ascii_lowercase().as_str() {
        "jpeg" | "jpg" => "jpg".to_string(),
        "" => "png".to_string(),
        other => other.to_string(),
    };
    let base = origin
        .filter(|origin| !origin.starts_with("data:"))
        .map(|origin| {
            let path = origin.split(['?', '#']).next().unwrap_or(origin);
            path.rsplit(['/', '\\']).next().unwrap_or("").to_string()
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("image-{id}"));
    let stem = base
        .rsplit_once('.')
        .map_or(base.as_str(), |(stem, _)| stem);
    let mut name: String = stem
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(120)
        .collect();
    let _ = write!(name, ".{ext}");
    name
}

/// Reads a `.pur` file's bytes into a [`Board`]. `scratch_dir` receives the
/// reassembled database while it is read (removed afterwards).
pub async fn read_board(file: &[u8], scratch_dir: &Path) -> Result<Board, CoreError> {
    let (header, database) = split_container(file)?;
    tokio::fs::create_dir_all(scratch_dir).await?;
    let scratch = tempfile::Builder::new()
        .prefix("pureref-")
        .suffix(".sqlite")
        .tempfile_in(scratch_dir)?;
    tokio::fs::write(scratch.path(), &database).await?;
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(scratch.path())
                .read_only(true),
        )
        .await
        .map_err(|error| CoreError::Db(error.to_string()))?;
    let result = read_tables(&pool, header.app_version).await;
    pool.close().await;
    drop(scratch);
    result
}

fn db_error(error: &sqlx::Error) -> CoreError {
    CoreError::Db(error.to_string())
}

/// A Qt value column, read with its storage class.
fn qt_column(row: &sqlx::sqlite::SqliteRow, type_col: &str, value_col: &str) -> Option<Vec<u8>> {
    let stored: String = row.try_get(type_col).ok()?;
    let raw: Vec<u8> = row.try_get(value_col).ok()?;
    (stored != "null").then(|| qt_bytes(&stored, &raw))
}

#[allow(clippy::too_many_lines)]
async fn read_tables(pool: &SqlitePool, app_version: String) -> Result<Board, CoreError> {
    // The item tree: local transforms, paint order, opacity.
    struct Node {
        parent: i64,
        local: Transform,
        z: f64,
        opacity: f64,
    }

    let mut board = Board {
        app_version,
        ..Board::default()
    };
    let mut nodes = std::collections::HashMap::new();
    for row in sqlx::query(
        "SELECT id, parent, typeof(transform) AS t, CAST(transform AS BLOB) AS v, z, opacity FROM items",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| db_error(&e))?
    {
        let local = qt_column(&row, "t", "v")
            .and_then(|bytes| decode_transform(&bytes).ok())
            .unwrap_or(Transform::IDENTITY);
        nodes.insert(
            row.get::<i64, _>("id"),
            Node {
                parent: row.try_get("parent").unwrap_or(-1),
                local,
                z: row.try_get("z").unwrap_or(0.0),
                opacity: row.try_get::<f64, _>("opacity").unwrap_or(1.0).clamp(0.0, 1.0),
            },
        );
    }
    let world = |id: i64| -> Transform {
        let mut transform = Transform::IDENTITY;
        let mut current = id;
        for _ in 0..64 {
            let Some(node) = nodes.get(&current) else {
                break;
            };
            transform = transform.then(&node.local);
            current = node.parent;
        }
        transform
    };

    // Resources: embedded bytes only; linked files are reported.
    let mut sizes = std::collections::HashMap::new();
    for row in sqlx::query("SELECT id, origin, source, format, data, CAST(width AS REAL) AS width, CAST(height AS REAL) AS height FROM images")
        .fetch_all(pool)
        .await
        .map_err(|e| db_error(&e))?
    {
        let id: i64 = row.get("id");
        let origin: Option<String> = row.try_get("origin").ok().flatten();
        let source: Option<String> = row.try_get("source").ok().flatten();
        let data: Option<Vec<u8>> = row.try_get("data").ok().flatten();
        match data.filter(|bytes| !bytes.is_empty()) {
            Some(bytes) => {
                let name_from = origin
                    .as_deref()
                    .filter(|o| !o.is_empty())
                    .or(source.as_deref());
                let format: Option<String> = row.try_get("format").ok().flatten();
                board.resources.push(Resource {
                    id,
                    filename: filename_from(name_from, format.as_deref(), id),
                    bytes,
                });
                // Pixel sizes: read as REAL, exact for any real image size.
                let width: Option<f64> = row.try_get("width").ok().flatten();
                let height: Option<f64> = row.try_get("height").ok().flatten();
                if let (Some(w), Some(h)) = (width, height) {
                    sizes.insert(id, (w, h));
                }
            }
            None => board.skipped.push(format!(
                "linked image (not embedded in the file): {}",
                source.or(origin).unwrap_or_default()
            )),
        }
    }

    let mut placed: Vec<(f64, Placed)> = Vec::new();
    for row in sqlx::query(
        "SELECT id, image, typeof(image_transform) AS tt, CAST(image_transform AS BLOB) AS tv, \
                typeof(image_bounds) AS bt, CAST(image_bounds AS BLOB) AS bv FROM items_images",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| db_error(&e))?
    {
        let id: i64 = row.get("id");
        let resource: i64 = row.get("image");
        let Some(&(width, height)) = sizes.get(&resource) else {
            continue;
        };
        let image_to_item = qt_column(&row, "tt", "tv")
            .and_then(|bytes| decode_transform(&bytes).ok())
            .unwrap_or(Transform {
                dx: -width / 2.0,
                dy: -height / 2.0,
                ..Transform::IDENTITY
            });
        let clip = qt_column(&row, "bt", "bv")
            .and_then(|bytes| decode_path(&bytes).ok())
            .unwrap_or_default();
        let Some(node) = nodes.get(&id) else { continue };
        if let Some(placement) = place_image(width, height, &image_to_item, &world(id), &clip) {
            placed.push((
                node.z,
                Placed::Image {
                    resource,
                    placement,
                    opacity: node.opacity,
                },
            ));
        }
    }

    for row in sqlx::query(
        "SELECT id, text, background_color, typeof(fixed_size) AS st, CAST(fixed_size AS BLOB) AS sv \
         FROM items_notes",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| db_error(&e))?
    {
        let id: i64 = row.get("id");
        let Some(node) = nodes.get(&id) else { continue };
        let html: String = row.try_get("text").ok().flatten().unwrap_or_default();
        let (text, font_px) = note_text(&html);
        let fixed = qt_column(&row, "st", "sv").and_then(|bytes| decode_size(&bytes).ok());
        let background: Option<String> = row.try_get("background_color").ok().flatten();
        let (bg_color, alpha) = background
            .as_deref()
            .and_then(note_color)
            .map_or((None, 1.0), |(color, alpha)| (Some(color), alpha));
        placed.push((
            node.z,
            Placed::Note {
                placement: place_note(text, font_px, fixed, &world(id)),
                bg_color,
                opacity: (node.opacity * alpha).clamp(0.0, 1.0),
            },
        ));
    }

    let drawings: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM items_drawings WHERE length(strokes) > 0")
            .fetch_one(pool)
            .await
            .unwrap_or(0);
    if drawings > 0 {
        board.skipped.push(format!(
            "{drawings} drawing{} (RefThing has no drawings yet)",
            if drawings == 1 { "" } else { "s" }
        ));
    }

    placed.sort_by(|a, b| a.0.total_cmp(&b.0));
    board.placed = placed.into_iter().map(|(_, placed)| placed).collect();
    Ok(board)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qstring(text: &str) -> Vec<u8> {
        let units: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
        let mut out = u32::try_from(units.len()).unwrap().to_be_bytes().to_vec();
        out.extend(units);
        out
    }

    fn variant_transform(t: [f64; 9]) -> Vec<u8> {
        let mut out = 80_u32.to_be_bytes().to_vec();
        out.push(0);
        for value in t {
            out.extend(value.to_be_bytes());
        }
        out
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    #[test]
    fn container_reassembles_the_displaced_database() {
        // A fake 2.1 file: header, then db[H..N], then db[0..H].
        let mut header = qstring("2.1");
        header.extend(0_u32.to_be_bytes());
        let n_at = header.len();
        header.extend(0_u64.to_be_bytes()); // N, patched below
        header.extend(qstring("2.1.3"));
        header.extend(qstring(&"0".repeat(32)));
        header.extend(3_u32.to_be_bytes());
        header.extend([1, 2, 3]); // thumbnail
        let h = header.len();
        let mut database = b"SQLite format 3\0".to_vec();
        database.resize(h + 500, 7);
        let n = database.len();
        header[n_at..n_at + 8].copy_from_slice(&(n as u64).to_be_bytes());
        let mut file = header.clone();
        file.extend(&database[h..]);
        file.extend(&database[..h]);
        let (parsed, rebuilt) = split_container(&file).unwrap();
        assert_eq!(parsed.app_version, "2.1.3");
        assert_eq!(parsed.header_len, h);
        assert_eq!(rebuilt, database);
        assert!(
            split_container(&file[..file.len() - 1]).is_err(),
            "lengths must add up"
        );
    }

    #[test]
    fn text_columns_decode_latin1_per_byte() {
        let raw = variant_transform([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 100.0, 200.0, 1.0]);
        let as_text: String = raw.iter().map(|&b| char::from(b)).collect();
        let bytes = qt_bytes("text", as_text.as_bytes());
        assert_eq!(bytes, raw);
        let t = decode_transform(&bytes).unwrap();
        assert!(close(t.dx, 100.0) && close(t.dy, 200.0));
    }

    #[test]
    fn a_centred_image_lands_at_its_item_position() {
        // PureRef's default: image_transform = translate(-w/2, -h/2), the
        // item placed at its centre (500, 300) at half scale.
        let (w, h) = (400.0, 200.0);
        let image_to_item = Transform {
            dx: -w / 2.0,
            dy: -h / 2.0,
            ..Transform::IDENTITY
        };
        let item = Transform {
            m11: 0.5,
            m22: 0.5,
            dx: 500.0,
            dy: 300.0,
            ..Transform::IDENTITY
        };
        let p = place_image(w, h, &image_to_item, &item, &[]).unwrap();
        assert!(close(p.width, 200.0) && close(p.height, 100.0));
        assert!(close(p.x, 400.0) && close(p.y, 250.0));
        assert!(close(p.rotation, 0.0) && !p.flip_x && p.crop.is_none());
    }

    #[test]
    fn rotation_mirror_and_parent_compose() {
        let image_to_item = Transform {
            dx: -50.0,
            dy: -50.0,
            ..Transform::IDENTITY
        };
        // 90° clockwise (y-down): x axis → +y, y axis → −x.
        let rotated = Transform {
            m11: 0.0,
            m12: 1.0,
            m21: -1.0,
            m22: 0.0,
            dx: 10.0,
            dy: 0.0,
        };
        let parent = Transform {
            dx: 1000.0,
            dy: 0.0,
            ..Transform::IDENTITY
        };
        let p = place_image(100.0, 100.0, &image_to_item, &rotated.then(&parent), &[]).unwrap();
        assert!(close(p.rotation, 90.0), "rotation {}", p.rotation);
        assert!(
            close(p.x + p.width / 2.0, 1010.0),
            "centre follows the parent"
        );
        let mirrored = Transform {
            m11: -1.0,
            ..Transform::IDENTITY
        };
        let m = place_image(100.0, 100.0, &image_to_item, &mirrored, &[]).unwrap();
        assert!(m.flip_x && close(m.rotation, 0.0));
    }

    #[test]
    fn clip_paths_become_crops() {
        let image_to_item = Transform {
            dx: -50.0,
            dy: -25.0,
            ..Transform::IDENTITY
        };
        // Keep the right half: item-space x 0..50 of a 100×50 image.
        let clip = [
            (0.0, -25.0),
            (50.0, -25.0),
            (50.0, 25.0),
            (0.0, 25.0),
            (0.0, -25.0),
        ];
        let p = place_image(100.0, 50.0, &image_to_item, &Transform::IDENTITY, &clip).unwrap();
        let (cx, cy, cw, ch) = p.crop.unwrap();
        assert!(close(cx, 0.5) && close(cy, 0.0) && close(cw, 0.5) && close(ch, 1.0));
        assert!(
            close(p.x, 0.0) && close(p.width, 50.0),
            "frame is the kept half"
        );
    }

    #[test]
    fn notes_keep_text_size_and_plain_text() {
        let html = "<html><head><style>p { x }</style></head><body style=\" font-family:'Open Sans'; font-size:22px;\">\
                    <p>Head/Face</p><p>A &amp; B</p></body></html>";
        let (text, font) = note_text(html);
        assert_eq!(text, "Head/Face\nA & B");
        assert!(close(font, 22.0));
        let to_world = Transform {
            m11: 5.0,
            m22: 5.0,
            dx: 100.0,
            dy: 50.0,
            ..Transform::IDENTITY
        };
        let note = place_note(text, font, None, &to_world);
        assert!(close(note.scale, 22.0 * 5.0 / 15.0));
        assert!(
            close(note.x, 100.0) && close(note.y, 50.0),
            "top-left stays put"
        );
        assert!(
            note.height > 2.0 * REFTHING_NOTE_LINE_PX * note.scale,
            "two lines fit"
        );
    }

    #[test]
    fn colours_and_filenames() {
        assert_eq!(
            note_color("#80ff0000"),
            Some(("#ff0000".to_string(), 128.0 / 255.0))
        );
        assert_eq!(note_color(""), None);
        assert_eq!(
            filename_from(
                Some("https://i.pinimg.com/736x/48/ab.jpg?x=1"),
                Some("JPG"),
                3
            ),
            "ab.jpg"
        );
        assert_eq!(
            filename_from(Some("image.jpg"), Some("PNG"), 3),
            "image.png"
        );
        assert_eq!(filename_from(None, Some("GIF"), 9), "image-9.gif");
    }
}
