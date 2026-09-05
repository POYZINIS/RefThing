-- RefThing Phase 2: board event log (op log for WS diffs/gap recovery) and the
-- SQLite-outbox job queue.

-- One row per committed board mutation (per batch, NOT per op). `seq` comes
-- from `UPDATE boards SET seq = seq + 1 ... RETURNING seq` inside the same
-- transaction; UNIQUE(board_id, seq) doubles as the (board_id, seq) index.
CREATE TABLE board_events (
    id         INTEGER PRIMARY KEY,
    board_id   TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    origin     TEXT, -- client_id of the mutating connection; NULL = server
    ops_json   TEXT NOT NULL CHECK (json_valid (ops_json)), -- BatchOp array
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (board_id, seq)
);

-- Custom outbox queue: enqueue happens inside the mutation's transaction, so
-- a job can never be lost between commit and enqueue. `run_after` is epoch-ms.
CREATE TABLE jobs (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid (payload_json)),
    status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    attempts     INTEGER NOT NULL DEFAULT 0,
    run_after    INTEGER NOT NULL DEFAULT 0, -- epoch-ms; claimable when <= now
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_jobs_pending ON jobs (run_after, id) WHERE status = 'pending';
