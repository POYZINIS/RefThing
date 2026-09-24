-- RefThing Phase 6: saved views (named viewport bookmarks).
--
-- A view is a named snapshot of the board viewport state `{x, y, zoom}`.
-- Views are board-scoped, purely a convenience layer on top of the live
-- viewport: navigating to a view just re-applies its viewport state to the
-- canvas (no item data is duplicated, no event-log entries are emitted).

CREATE TABLE board_views (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    viewport    TEXT NOT NULL CHECK (json_valid(viewport)), -- {x,y,zoom} JSON
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_board_views_board ON board_views (board_id);