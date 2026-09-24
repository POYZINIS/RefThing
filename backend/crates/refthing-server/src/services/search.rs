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

    // Sanitize: split on whitespace, join with " OR ".
    let fts_query = q
        .split_whitespace()
        .map(|token| format!("\"{token}\""))
        .collect::<Vec<_>>()
        .join(" OR ");

    let rows = sqlx::query(
        "SELECT item_id AS item_id,
                kind AS kind,
                bm25(search_index) AS rank,
                snippet(search_index, 3, '<b>', '</b>', '…', ?) AS snippet
         FROM search_index
         WHERE board_id = ? AND search_index MATCH ?
         ORDER BY rank ASC
         LIMIT 50",
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

    // SQLite-only: iterate item_metadata rows on this board, parse the json,
    // and compute squared distance. We do this in SQL for one round-trip.
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
        for color in colors {
            let Some((cr, cg, cb)) = color.as_str().and_then(parse_hex_colour) else {
                continue;
            };
            let dr = cr - r;
            let dg = cg - g;
            let db = cb - b;
            if dr * dr + dg * dg + db * db <= COLOUR_EPSILON_SQ {
                matches.push(dto::SearchResult {
                    item_id: row.try_get("item_id").unwrap(),
                    rank: 0.0,
                    snippet: format!("colour {colour}"),
                    kind: "colour".to_string(),
                });
                break;
            }
        }
    }

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
    let mut hashes: Vec<(Uuid, String)> = Vec::new();
    for row in &rows {
        let json_text: String = row.try_get("json").unwrap_or_default();
        let value: serde_json::Value =
            serde_json::from_str(&json_text).unwrap_or(serde_json::Value::Null);
        if let Some(phash) = value.get("phash").and_then(|v| v.as_str()) {
            hashes.push((row.try_get("item_id").unwrap(), phash.to_string()));
        }
    }

    // O(n²) Hamming comparison — acceptable for reference boards (thousands
    // of items, and the hash comparison is a single u64 XOR).
    let mut groups: Vec<dto::SearchResult> = Vec::new();
    for (i, (left_id, left_hash)) in hashes.iter().enumerate() {
        let mut matches: Vec<(f64, String)> = Vec::new();
        for (right_id, right_hash) in hashes.iter().skip(i + 1) {
            let Some(distance) = refthing_core::pipeline::hamming_distance(left_hash, right_hash)
            else {
                continue;
            };
            if distance <= DUPE_THRESHOLD {
                matches.push((f64::from(distance), right_id.to_string()));
            }
        }
        if !matches.is_empty() {
            matches.sort_by(|a, b| a.0.total_cmp(&b.0));
            let snippet = matches
                .iter()
                .map(|(_, id)| id.as_str())
                .collect::<Vec<_>>()
                .join(",");
            groups.push(dto::SearchResult {
                item_id: *left_id,
                rank: matches[0].0,
                snippet,
                kind: "duplicate".to_string(),
            });
        }
    }

    Ok(groups)
}
