-- RefThing Phase 6: FTS5 full-text search index.
--
-- One FTS5 row per searchable item/note: the board id plus a single indexed
-- `content` column holding the concatenated searchable text (blob filename,
-- tag names, note text). The `kind` column distinguishes the match source
-- (filename/note/tag) for UI display. FTS5 requires all columns be TEXT;
-- `item_id`, `board_id`, `kind` are UNINDEXED (raw storage, no tokenization).
--
-- The index is a plain (non-contentless) FTS5 table so DELETE by column
-- value works. Triggers keep it roughly in sync; note that metadata-driven
-- content (tags) is re-indexed on item_tags changes, and blob renames are
-- not modelled (blobs are content-addressed and immutable).

CREATE VIRTUAL TABLE search_index USING fts5(
    item_id UNINDEXED,
    board_id UNINDEXED,
    kind UNINDEXED,
    content,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- --- items: index by original filename (via blob) ---

CREATE TRIGGER search_index_items_ai AFTER INSERT ON items BEGIN
    INSERT INTO search_index (item_id, board_id, kind, content)
    VALUES (
        new.id,
        new.board_id,
        'filename',
        COALESCE((SELECT original_filename FROM blobs WHERE hash = new.blob_id), '')
    );
END;

CREATE TRIGGER search_index_items_ad AFTER DELETE ON items BEGIN
    DELETE FROM search_index WHERE item_id = old.id AND kind = 'filename';
END;

CREATE TRIGGER search_index_items_au AFTER UPDATE OF blob_id ON items BEGIN
    DELETE FROM search_index WHERE item_id = old.id AND kind = 'filename';
    INSERT INTO search_index (item_id, board_id, kind, content)
    VALUES (
        new.id,
        new.board_id,
        'filename',
        COALESCE((SELECT original_filename FROM blobs WHERE hash = new.blob_id), '')
    );
END;

-- --- notes: index by plain-text content (content_json.text) ---

CREATE TRIGGER search_index_notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO search_index (item_id, board_id, kind, content)
    VALUES (
        new.id,
        new.board_id,
        'note',
        COALESCE(json_extract(new.content_json, '$.text'), '')
    );
END;

CREATE TRIGGER search_index_notes_ad AFTER DELETE ON notes BEGIN
    DELETE FROM search_index WHERE item_id = old.id AND kind = 'note';
END;

CREATE TRIGGER search_index_notes_au AFTER UPDATE OF content_json ON notes BEGIN
    DELETE FROM search_index WHERE item_id = old.id AND kind = 'note';
    INSERT INTO search_index (item_id, board_id, kind, content)
    VALUES (
        new.id,
        new.board_id,
        'note',
        COALESCE(json_extract(new.content_json, '$.text'), '')
    );
END;

-- --- blobs: filename may be backfilled/updated (rare, but harmless) ---

CREATE TRIGGER search_index_blobs_au AFTER UPDATE OF original_filename ON blobs BEGIN
    DELETE FROM search_index
    WHERE item_id IN (SELECT id FROM items WHERE blob_id = old.hash)
      AND kind = 'filename';
    INSERT INTO search_index (item_id, board_id, kind, content)
    SELECT i.id, i.board_id, 'filename', new.original_filename
    FROM items i WHERE i.blob_id = new.hash;
END;

-- --- item_tags: re-index items when tags change ---

CREATE TRIGGER search_index_tags_ai AFTER INSERT ON item_tags BEGIN
    -- Rebuild the item's content as filename + tag names, preserving the
    -- filename part (items are immutable once created beyond blob_id, which
    -- the items trigger handles).
    DELETE FROM search_index WHERE item_id = new.item_id AND kind = 'filename';
    INSERT INTO search_index (item_id, board_id, kind, content)
    SELECT
        i.id,
        i.board_id,
        'filename',
        COALESCE((SELECT original_filename FROM blobs WHERE hash = i.blob_id), '')
            || ' ' ||
            (SELECT group_concat(t.name, ' ') FROM tags t
             JOIN item_tags it ON it.tag_id = t.id WHERE it.item_id = i.id)
    FROM items i WHERE i.id = new.item_id;
END;

CREATE TRIGGER search_index_tags_ad AFTER DELETE ON item_tags BEGIN
    DELETE FROM search_index WHERE item_id = old.item_id AND kind = 'filename';
    INSERT INTO search_index (item_id, board_id, kind, content)
    SELECT
        i.id,
        i.board_id,
        'filename',
        COALESCE((SELECT original_filename FROM blobs WHERE hash = i.blob_id), '')
            || ' ' ||
            (SELECT group_concat(t.name, ' ') FROM tags t
             JOIN item_tags it ON it.tag_id = t.id WHERE it.item_id = i.id)
    FROM items i WHERE i.id = old.item_id;
END;