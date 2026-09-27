# Data Model (Phase 1)

RefThing persists everything under the gitignored `data/` directory: a
SQLite database (`data/refthing.db`) plus a content-addressed blob store
on disk (`data/blobs/`). Migrations live in `backend/migrations/` and run
embedded at startup via `sqlx::migrate!()` — forward-only, no
down-migrations (rollback = restore a board export).

All IDs are `TEXT` UUIDv7 (time-ordered, k-sortable). All timestamps are
`TEXT` ISO-8601 UTC with
`DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`.

## Tables

| Table | Why it exists |
|:------|:--------------|
| `boards` | One row per board: name, `viewport_state` (JSON `{x,y,zoom}`, nullable = default view), `seq` (see below). |
| `items` | One row per canvas item: board FK, `type` string, optional `blob_id` FK, transform (`x`, `y`, `width`, `height`, `rotation`, `z_index`), optional `group_id`. |
| `item_metadata` | 1:1 with `items`; a `json_valid`-checked JSON payload whose shape is per item type. This is the Phase 11 extensibility seam — new types store their fields here instead of new columns. |
| `groups` | Hierarchical (`parent_group_id` self-FK) item grouping: name, `collapsed`, `bg_color`, `opacity`, `locked` (§6 RULE 3: no group-level transforms; migration 0009). |
| `notes` | Standalone rich-text notes on the board: transform (incl. `rotation`, `z_index`) + `content_json` + `bg_color`/`opacity`. Kept separate from `items` because notes never reference blobs. |

**One paint order.** `items.z_index` and `notes.z_index` are a single space:
the canvas interleaves both kinds, a new item or note lands at
`max(both) + 1`, and selecting a node raises it above everything.

**Item metadata keys written by the app** (merge-patched, see below):
`flip_x` / `flip_y` (bool, mirrored about the item's own axes), `opacity`
(0–1). The pyramid job merges `dominant_colors` and `phash` into the same
object. Updates are RFC 7396 merge patches (SQLite `json_patch`): named keys
are set, `null` deletes a key, all other keys are kept — so a client never
wipes pipeline data.
| `tags` / `item_tags` | Case-insensitive unique tag names (`UNIQUE COLLATE NOCASE`) plus the many-to-many join table. |
| `blobs` | One row per unique file content, keyed by its SHA-256 hex hash: original filename, sniffed MIME, byte size, pixel dimensions. Content-addressing gives dedup for free. |

Key indexes: `items(board_id, z_index)` is the hot paint-order scan;
partial indexes on `items(group_id)` and `items(blob_id)` serve group
lookups and the blob refcount/GC sweep; `item_tags(tag_id)` serves the
"all items with tag X" filter.

## Deliberate deviations from the product-plan sketch

These are intentional — do not "fix" them back to the sketch:

1. **`items.blob_id` FK added.** The sketch had no link from items to
   blobs at all. `ON DELETE RESTRICT` so a referenced blob can't vanish;
   `NULL` for link/embed-only items.
2. **`updated_at` + triggers from day one** on `items`, `boards`, and
   `notes`. Phase 8 last-write-wins sync is dead without it, and adding
   the column later means backfilling. The timestamps are maintained by
   SQL triggers (`migrations/0002_updated_at_triggers.sql`), not Rust-side
   writes, so they're correct for any writer — including future sync.
3. **`boards.seq` column.** A monotonic per-board sequence counter, bumped
   once per mutation transaction
   (`UPDATE boards SET seq = seq + 1 WHERE id = ? RETURNING seq`). It is
   the cursor for the WebSocket diff stream and for
   `GET /changes?since={seq}` gap recovery. Bump **once per batch**, not
   per op.
4. **Group `bg_color`/`opacity` hoisted** from Phase 5 into the initial
   schema — additive now, painful to backfill later.
5. **No `CHECK` constraint on `items.type`.** This is the Phase 11
   extensibility invariant: a new item type must be a new `type` string +
   a new `item_metadata.json` shape, with **zero schema changes**. Old
   clients render unknown types via the generic-file poster. Never add a
   `CHECK` (or an enum column) on `items.type` — see
   `docs/onboarding-new-item-type.md`.

## Blob store layout

```
data/
├── refthing.db (+ .db-wal, .db-shm)
├── blobs/
│   └── ab/cd/abcdef0123…     # sha256[0..2]/sha256[2..4]/full-64-hex, no extension
├── deriv/                    # Phase 3 pyramid levels (regenerable; excluded from export)
└── tmp/<uuidv7>.part         # ingest scratch
```

- **Ingest is atomic.** Stream the upload to `tmp/*.part` while hashing
  (single pass) and sniffing MIME via `infer` (never trust client-supplied
  MIME), then `rename` into `blobs/`. A partial blob can never appear at
  a canonical path. Windows caveat: rename-over-existing fails, so an
  existing destination means a dedup hit — delete the tmp file instead.
- **Two-level prefix sharding** keeps directory fan-out bounded and plays
  nice with NTFS + antivirus scanning.
- **Dedup is free:** identical content hashes to the same path and the
  same `blobs` row, no matter how many items or boards reference it.
- **GC:** delete blobs whose hash nothing references — no item
  (`items.blob_id`) and no 3D model's texture (a hash string under
  `item_metadata.json` → `$.model.textures`, read with `json_each`) —
  after a grace period. The zip export collects the same two sets. Never inline-delete on item removal — undo and
  snapshots come later.

## Phase 11 promotion rule

`item_metadata.json` fields are not queryable at scale — that's fine for
display-only data. When a Phase 11 field needs **sort or filter at
scale**, promote it with a SQLite generated column:

```sql
ALTER TABLE items ADD COLUMN duration_ms INTEGER
  GENERATED ALWAYS AS (
    json_extract((SELECT json FROM item_metadata WHERE item_id = items.id),
                 '$.duration_ms')
  ) VIRTUAL;
```

This is an additive migration: no backfill, no rewrite of existing rows,
and it can be indexed on demand. Display-only fields stay in the JSON
payload forever.

## Backup warning: zip export is the ONLY supported backup path

The database runs in WAL mode, so live data sits in `refthing.db-wal`
(and `-shm`) alongside `refthing.db`. **Copying `refthing.db` alone
produces a stale or corrupt backup.** The supported way to back up or
move a board is the Phase 1 zip export (`manifest.json` + deduplicated
blobs, hashes verified on import). Never treat a file copy of the
database as a backup.

## Blob hash algorithm: SHA-256, locked

SHA-256 (64-char lowercase hex) is the permanent content key for every
blob on disk and every hash in every export manifest. BLAKE3 (~10x
faster) was considered and **rejected for v1 interop** — SHA-256 is
universally verifiable outside the app — and the decision is baked into
existing data, so it is not revisitable without a full store migration.
