-- RefThing Phase 7: versioned board snapshots for rollback.
--
-- A snapshot is a lightweight, immutable copy of a board's state at a point
-- in time (viewport + item positions + item metadata), stored as JSON. The
-- most recent N versions per board are kept (PRUNE_KEEP in the snapshot
-- service). Snapshots back the rollback feature: restore a board to any of
-- its recent states.
--
-- Columns:
--   board_id   which board this snapshot belongs to
--   created_at when the snapshot was taken (sort key, newest first)
--   label      optional human label (e.g. "before cleanup")
--   data       the full board state JSON (what GET /boards/{id} returns)
--
-- The primary key is (board_id, created_at) so a single SQL row per version.
-- Timestamps are Unix epoch milliseconds to avoid SQLite text-date sorting.

CREATE TABLE IF NOT EXISTS board_snapshots (
    board_id   TEXT    NOT NULL,
    created_at INTEGER NOT NULL,  -- Unix epoch ms
    label      TEXT    NOT NULL DEFAULT '',
    data       TEXT    NOT NULL,
    PRIMARY KEY (board_id, created_at)
);
