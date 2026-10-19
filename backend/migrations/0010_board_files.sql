-- `.ref` board files: a board linked to a file on disk, which RefThing keeps
-- written in the background (services/ref_files.rs). One file per board and
-- one board per file.
--
-- `written_token` is the board's change token (seq | updated_at | ready
-- preview count) the file last got; the file is behind when the board's
-- token differs. `written_size` / `written_mtime_ms` identify the file as
-- written, so a file changed elsewhere (another machine, a sync client) is
-- opened fresh rather than mistaken for this board.

CREATE TABLE board_files (
    board_id         TEXT PRIMARY KEY REFERENCES boards (id) ON DELETE CASCADE,
    path             TEXT NOT NULL,
    written_token    TEXT,
    written_at       TEXT,
    written_size     INTEGER,
    written_mtime_ms INTEGER,
    error            TEXT
);

CREATE UNIQUE INDEX idx_board_files_path ON board_files (path COLLATE NOCASE);
