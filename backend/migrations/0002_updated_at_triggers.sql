-- Touch triggers keep updated_at correct for any writer, including future sync.
-- recursive_triggers is OFF by default in SQLite, so each trigger's inner
-- UPDATE does not re-fire itself.

CREATE TRIGGER trg_boards_touch
AFTER UPDATE ON boards
BEGIN
    UPDATE boards SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_items_touch
AFTER UPDATE ON items
BEGIN
    UPDATE items SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_notes_touch
AFTER UPDATE ON notes
BEGIN
    UPDATE notes SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
