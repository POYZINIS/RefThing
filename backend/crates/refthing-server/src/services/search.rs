//! Full-text search service (Phase 6 FTS5 + colour search). Uses the
//! `search_index` virtual table populated by triggers on items/notes/tags/blobs,
//! and `item_metadata` for dominant-colour proximity search. Queries are
//! scoped to a single board and return ranked item IDs with snippets.

use refthing_core::error::CoreError;
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

use crate::dto;

const SNIPPET_LIMIT: i64 = 120;

/// Search a board's FTS5 index. Returns results ranked by BM25 (best first).
/// Empty `query` returns no results.
///
/// # Panics
///
/// Panics if `sqlx::Row::try_get` fails for columns that are guaranteed
/// present by the query schema (`item_id`, `rank`, `kind`).
pub async fn search(
    pool: &SqlitePool,
    board_id: Uuid,
    query: &str,
) -> Result<Vec<dto::SearchResult>, CoreError> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }

    // Treat every token as literal text, including embedded quotes. The user
    // does not need to know (or accidentally trigger) FTS5 query syntax.
    let fts_query = q
        .split_whitespace()
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");

    let rows = sqlx::query(
        "SELECT item_id AS item_id,
                kind AS kind,
                bm25(search_index) AS rank,
                snippet(search_index, 3, '<b>', '</b>', '…', ?) AS snippet
         FROM search_index
         WHERE board_id = ? AND search_index MATCH ?
         ORDER BY rank ASC",
    )
    .bind(SNIPPET_LIMIT)
    .bind(board_id)
    .bind(fts_query)
    .fetch_all(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;

    let results = rows
        .into_iter()
        .map(|row| dto::SearchResult {
            item_id: row.try_get("item_id").unwrap(),
            rank: row.try_get("rank").unwrap(),
            snippet: row.try_get("snippet").unwrap_or(None).unwrap_or_default(),
            kind: row
                .try_get("kind")
                .unwrap_or_else(|_| "filename".to_string()),
        })
        .collect();

    Ok(results)
}

/// Colour-space distance threshold (0–255) for "similar colour" matching.
const COLOUR_EPSILON_SQ: i64 = 40 * 40;

/// Parse a `#rrggbb` hex into (r, g, b), or `None` for invalid input.
fn parse_hex_colour(input: &str) -> Option<(i64, i64, i64)> {
    let hex = input.trim_start_matches('#');
    if hex.len() != 6 {
        return None;
    }
    let value = i64::from_str_radix(hex, 16).ok()?;
    Some(((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF))
}

/// Find items on a board whose `item_metadata.dominant_colors` contains a
/// colour within [`COLOUR_EPSILON_SQ`] of the requested hex.  Colour(s) with
/// alpha / non-hex input are ignored (404 → empty result).
///
/// # Panics
///
/// Panics if `sqlx::Row::try_get` fails for columns guaranteed present by
/// the query schema.
pub async fn search_by_colour(
    pool: &SqlitePool,
    board_id: Uuid,
    colour: &str,
) -> Result<Vec<dto::SearchResult>, CoreError> {
    let Some((r, g, b)) = parse_hex_colour(colour) else {
        return Ok(Vec::new());
    };

    // Fetch metadata in one round-trip, then rank by nearest palette colour.
    let rows = sqlx::query(
        "SELECT i.id AS item_id, m.json AS json
         FROM items i
         JOIN item_metadata m ON m.item_id = i.id
         WHERE i.board_id = ?
           AND json_extract(m.json, '$.dominant_colors') IS NOT NULL",
    )
    .bind(board_id)
    .fetch_all(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;

    let mut matches = Vec::new();
    for row in rows {
        let json_text: String = row.try_get("json").unwrap_or_default();
        let value: serde_json::Value =
            serde_json::from_str(&json_text).unwrap_or(serde_json::Value::Null);
        let Some(colors) = value.get("dominant_colors").and_then(|v| v.as_array()) else {
            continue;
        };
        let nearest = colors
            .iter()
            .filter_map(|color| color.as_str().and_then(parse_hex_colour))
            .map(|(cr, cg, cb)| (cr - r).pow(2) + (cg - g).pow(2) + (cb - b).pow(2))
            .min();
        if let Some(distance) = nearest.filter(|distance| *distance <= COLOUR_EPSILON_SQ) {
            matches.push(dto::SearchResult {
                item_id: row.try_get("item_id").unwrap(),
                rank: f64::from(u32::try_from(distance).unwrap_or_default()),
                snippet: format!("colour {colour}"),
                kind: "colour".to_string(),
            });
        }
    }

    matches.sort_by(|a, b| a.rank.total_cmp(&b.rank).then(a.item_id.cmp(&b.item_id)));
    Ok(matches)
}

/// Hamming distance at/below which two phashes count as duplicates.
const DUPE_THRESHOLD: u32 = 10;

/// Detect duplicate groups on a board by perceptual hash proximity. Returns
/// one entry per item that has a near-duplicate: `snippet` lists the other
/// items' ids, ranked by how close the hashes are.
///
/// # Panics
///
/// Panics if `sqlx::Row::try_get` fails for columns guaranteed present by
/// the query schema.
pub async fn find_duplicates(
    pool: &SqlitePool,
    board_id: Uuid,
) -> Result<Vec<dto::SearchResult>, CoreError> {
    let rows = sqlx::query(
        "SELECT i.id AS item_id, m.json AS json
         FROM items i
         JOIN item_metadata m ON m.item_id = i.id
         WHERE i.board_id = ?
           AND json_extract(m.json, '$.phash') IS NOT NULL",
    )
    .bind(board_id)
    .fetch_all(pool)
    .await
    .map_err(|error| CoreError::Db(error.to_string()))?;

    // Load all (item_id, phash) pairs.
    let mut hashes: Vec<(Uuid, u64)> = Vec::new();
    for row in &rows {
        let json_text: String = row.try_get("json").unwrap_or_default();
        let value: serde_json::Value =
            serde_json::from_str(&json_text).unwrap_or(serde_json::Value::Null);
        if let Some(phash) = value
            .get("phash")
            .and_then(|v| v.as_str())
            .filter(|hash| hash.len() == 16)
            .and_then(|hash| u64::from_str_radix(hash, 16).ok())
        {
            hashes.push((row.try_get("item_id").unwrap(), phash));
        }
    }

    // O(n²) Hamming comparison — acceptable for reference boards (thousands
    // of items, and the hash comparison is a single u64 XOR).
    let mut neighbours: Vec<Vec<(u32, Uuid)>> = vec![Vec::new(); hashes.len()];
    for (i, (left_id, left_hash)) in hashes.iter().enumerate() {
        for (j, (right_id, right_hash)) in hashes.iter().enumerate().skip(i + 1) {
            let distance = (left_hash ^ right_hash).count_ones();
            if distance <= DUPE_THRESHOLD {
                neighbours[i].push((distance, *right_id));
                neighbours[j].push((distance, *left_id));
            }
        }
    }
    let mut groups: Vec<dto::SearchResult> = Vec::new();
    for ((item_id, _), mut matches) in hashes.into_iter().zip(neighbours) {
        if !matches.is_empty() {
            matches.sort_unstable();
            let snippet = matches
                .iter()
                .map(|(_, id)| id.to_string())
                .collect::<Vec<_>>()
                .join(",");
            groups.push(dto::SearchResult {
                item_id,
                rank: f64::from(matches[0].0),
                snippet,
                kind: "duplicate".to_string(),
            });
        }
    }

    groups.sort_by(|a, b| a.rank.total_cmp(&b.rank).then(a.item_id.cmp(&b.item_id)));
    Ok(groups)
}
