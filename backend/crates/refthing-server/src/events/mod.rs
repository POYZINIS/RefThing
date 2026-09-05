//! Board event log: every committed board mutation appends one row carrying
//! the whole op array and bumps `boards.seq` exactly once. Powers WS diffs and
//! the `GET /api/boards/{id}/changes?since=` gap-recovery endpoint.
//!
//! All SQL here is runtime (`sqlx::query`, not the `query!` macros) so this
//! crate never perturbs the committed `.sqlx` offline cache.

pub mod hub;

pub use hub::BroadcastHub;

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool, SqliteTransaction};
use uuid::Uuid;

/// One row of `board_events`, as returned by [`replay_since`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BoardEvent {
    pub seq: i64,
    pub origin: Option<String>,
    /// The batch's `BatchOp` array, verbatim.
    pub ops: serde_json::Value,
    pub created_at: String,
}

/// Bumps `boards.seq` and inserts the event row inside `tx`. Returns the new
/// seq. The caller commits and then broadcasts a [`ServerMsg::Diff`] with the
/// returned seq.
///
/// # Errors
/// Returns [`sqlx::Error::RowNotFound`] if the board does not exist.
pub async fn append_event(
    tx: &mut SqliteTransaction<'_>,
    board_id: Uuid,
    origin: Option<&str>,
    ops: &serde_json::Value,
) -> Result<i64, sqlx::Error> {
    let row = sqlx::query("UPDATE boards SET seq = seq + 1 WHERE id = ? RETURNING seq")
        .bind(board_id)
        .fetch_one(&mut **tx)
        .await?;
    let seq: i64 = row.try_get("seq")?;

    sqlx::query("INSERT INTO board_events (board_id, seq, origin, ops_json) VALUES (?, ?, ?, ?)")
        .bind(board_id)
        .bind(seq)
        .bind(origin)
        .bind(ops.to_string())
        .execute(&mut **tx)
        .await?;

    Ok(seq)
}

/// Fetches all events for `board_id` with `seq > since_seq`, oldest first.
///
/// # Errors
/// Returns an error on database or `ops_json` decode failure.
pub async fn replay_since(
    pool: &SqlitePool,
    board_id: Uuid,
    since_seq: i64,
) -> Result<Vec<BoardEvent>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT seq, origin, ops_json, created_at FROM board_events \
         WHERE board_id = ? AND seq > ? ORDER BY seq",
    )
    .bind(board_id)
    .bind(since_seq)
    .fetch_all(pool)
    .await?;

    rows.iter()
        .map(|row| {
            let ops_json: String = row.try_get("ops_json")?;
            Ok(BoardEvent {
                seq: row.try_get("seq")?,
                origin: row.try_get("origin")?,
                ops: serde_json::from_str(&ops_json)
                    .map_err(|error| sqlx::Error::Decode(Box::new(error)))?,
                created_at: row.try_get("created_at")?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use refthing_core::db::{self, Pools};
    use serde_json::json;

    use super::*;

    async fn temp_pools() -> (tempfile::TempDir, Pools) {
        let dir = tempfile::tempdir().expect("temp dir");
        let pools = db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        (dir, pools)
    }

    async fn insert_board(pools: &Pools) -> Uuid {
        let board_id = Uuid::now_v7();
        sqlx::query("INSERT INTO boards (id, name) VALUES (?, 'board')")
            .bind(board_id)
            .execute(&pools.write)
            .await
            .expect("insert board");
        board_id
    }

    #[tokio::test]
    async fn append_bumps_seq_and_inserts_event() {
        let (_dir, pools) = temp_pools().await;
        let board_id = insert_board(&pools).await;

        for expected_seq in 1..=3 {
            let mut tx = pools.write.begin().await.expect("begin");
            let seq = append_event(&mut tx, board_id, Some("c1"), &json!([{"kind": "move"}]))
                .await
                .expect("append");
            tx.commit().await.expect("commit");
            assert_eq!(seq, expected_seq);
        }

        let events = replay_since(&pools.read, board_id, 0)
            .await
            .expect("replay");
        assert_eq!(events.len(), 3);
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[2].seq, 3);
        assert_eq!(events[1].origin.as_deref(), Some("c1"));
        assert_eq!(events[1].ops, json!([{"kind": "move"}]));
    }

    #[tokio::test]
    async fn replay_since_filters_and_orders() {
        let (_dir, pools) = temp_pools().await;
        let board_id = insert_board(&pools).await;
        let other_board = insert_board(&pools).await;

        for _ in 0..5 {
            let mut tx = pools.write.begin().await.expect("begin");
            append_event(&mut tx, board_id, None, &json!([]))
                .await
                .expect("append");
            tx.commit().await.expect("commit");
        }
        let mut tx = pools.write.begin().await.expect("begin");
        append_event(&mut tx, other_board, None, &json!([]))
            .await
            .expect("append other board");
        tx.commit().await.expect("commit");

        let events = replay_since(&pools.read, board_id, 3)
            .await
            .expect("replay");
        assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), [4, 5]);
        assert!(events.iter().all(|e| e.origin.is_none()));
    }

    #[tokio::test]
    async fn append_to_missing_board_is_row_not_found() {
        let (_dir, pools) = temp_pools().await;
        let mut tx = pools.write.begin().await.expect("begin");
        let result = append_event(&mut tx, Uuid::now_v7(), None, &json!([])).await;
        assert!(matches!(result, Err(sqlx::Error::RowNotFound)));
    }
}
