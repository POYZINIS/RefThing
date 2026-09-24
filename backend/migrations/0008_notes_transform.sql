-- RefThing notes upgrade: give notes the same transform shell as items.
--
-- rotation — notes rotate around their center (Ctrl+drag), like images.
-- z_index  — notes participate in the paint order and bring-to-front on
--            click, exactly like items (ascending z_index = back to front).
--
-- Existing notes get rotation 0 and z_index 0 (they render below images,
-- which matches how they rendered before this migration — the items table
-- was the only z-ordered layer).

ALTER TABLE notes ADD COLUMN rotation REAL NOT NULL DEFAULT 0;
ALTER TABLE notes ADD COLUMN z_index INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_notes_z ON notes (board_id, z_index);