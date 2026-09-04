-- RefThing Phase 1 initial schema.
-- IDs are TEXT UUIDv7; timestamps are TEXT ISO-8601 UTC.
-- `items.type` deliberately has no CHECK constraint: new Phase 11 item types
-- must not require a migration.

PRAGMA foreign_keys = ON; -- sqlx sets this per-connection anyway; belt and suspenders

CREATE TABLE boards (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    seq            INTEGER NOT NULL DEFAULT 0, -- Phase 2 event-log sequence
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    viewport_state TEXT CHECK (json_valid(viewport_state)) -- {x,y,zoom} JSON; NULL = default view
);

CREATE TABLE groups (
    id              TEXT PRIMARY KEY,
    board_id        TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    parent_group_id TEXT REFERENCES groups (id) ON DELETE CASCADE,
    name            TEXT NOT NULL DEFAULT '',
    collapsed       INTEGER NOT NULL DEFAULT 0,
    bg_color        TEXT, -- Phase 5 group styling; cheap to add now
    opacity         REAL NOT NULL DEFAULT 1.0,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_groups_board ON groups (board_id);

CREATE TABLE blobs (
    hash              TEXT PRIMARY KEY, -- 64-char lowercase hex SHA-256
    original_filename TEXT,
    mime_type         TEXT NOT NULL, -- sniffed via `infer`, never client-supplied
    byte_size         INTEGER NOT NULL,
    width             INTEGER, -- NULL for non-images
    height            INTEGER,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE items (
    id         TEXT PRIMARY KEY,
    board_id   TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    type       TEXT NOT NULL, -- no CHECK: Phase 11 types land without migration
    blob_id    TEXT REFERENCES blobs (hash) ON DELETE RESTRICT, -- NULL for link/embed-only items
    x          REAL NOT NULL DEFAULT 0,
    y          REAL NOT NULL DEFAULT 0,
    width      REAL NOT NULL,
    height     REAL NOT NULL,
    rotation   REAL NOT NULL DEFAULT 0, -- degrees, clockwise
    z_index    INTEGER NOT NULL DEFAULT 0,
    group_id   TEXT REFERENCES groups (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) -- Phase 8 LWW needs this from day one
);
CREATE INDEX idx_items_board_paint ON items (board_id, z_index); -- paint-order scan, the hot query
CREATE INDEX idx_items_group ON items (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_items_blob ON items (blob_id) WHERE blob_id IS NOT NULL; -- refcount/GC sweep

CREATE TABLE item_metadata (
    item_id TEXT PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
    json    TEXT NOT NULL CHECK (json_valid(json)) -- per-type payload
);

CREATE TABLE notes (
    id           TEXT PRIMARY KEY,
    board_id     TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    x            REAL NOT NULL DEFAULT 0,
    y            REAL NOT NULL DEFAULT 0,
    width        REAL NOT NULL,
    height       REAL NOT NULL,
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    bg_color     TEXT,
    opacity      REAL NOT NULL DEFAULT 1.0,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_notes_board ON notes (board_id);

CREATE TABLE tags (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT
);

CREATE TABLE item_tags (
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    tag_id  TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
);
CREATE INDEX idx_item_tags_tag ON item_tags (tag_id); -- "all items with tag X" filter
