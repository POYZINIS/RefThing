# API Reference — RefThing

This documents the API as **implemented** in `backend/crates/refthing-server`
(Phases 2 and 3). Future work is marked **Phase 4+**.

- Base URL: `http://localhost:7171` (see `AGENTS.md` for ports).
- All request/response bodies are JSON unless noted; all UUIDs are v7;
  all timestamps in DTOs are **epoch milliseconds** (i64).
- Auth: local-first single-user session. `POST /api/auth/session` issues a
  startup-scoped token and an HttpOnly `refthing_session` cookie. Clients may
  also send `Authorization: Bearer <token>`. Requests without credentials are
  accepted as the local desktop user; supplied invalid credentials return 401.
- Middleware (`src/router.rs`): CORS is permissive. The JSON API
  (`/api/boards`, `/api/tags`, `/api/health`, …) gets response compression and
  a **30 s request timeout**. Ingest, WebSocket, and blob routes get neither.

## Error envelope

Every non-2xx JSON API response is:

```json
{ "error": { "code": "not_found", "message": "board not found" } }
```

| Status | `code`               | Meaning                                                        |
|:-------|:---------------------|:---------------------------------------------------------------|
| 400    | `bad_request`        | Validation failure (empty patch, bad geometry, bad parent, …)  |
| 404    | `not_found`          | Unknown board / item / group / note / tag / blob               |
| 409    | `seq_conflict`       | Stale `base_seq` on batch or item PATCH (see Seq contract)     |
| 409    | `conflict`           | Other conflicts (duplicate tag name)                           |
| 413    | `too_large`          | Multipart body over the 1 GiB ingest limit                     |
| 415    | `unsupported_media`  | Reserved (no handler emits it today)                           |
| 500    | `internal`           | DB / I/O failure                                               |

Note: `seq_conflict` is a narrower code than `AppError::Conflict`'s generic
`conflict` — only the batch-capable item routes emit it.

## Seq / optimistic concurrency contract

Every board carries a monotonic `seq` (the event-log cursor). The rules:

- **One bump per request.** Each committed mutation — single-item write,
  batch, ingest of one file, board/group/note edit — runs in ONE transaction,
  bumps `boards.seq` exactly once, and appends ONE `board_events` row
  (`src/events/mod.rs`). Tags are global and bump nothing.
- **`base_seq` must equal the board's current seq** on
  `POST …/items/batch` and (when provided) on `PATCH …/items/{item_id}`.
  A mismatch returns **409 `seq_conflict`** with message
  `base_seq N is stale; board is at seq M`. The client then refetches
  `/changes?since=N` and rebases. Omitting `base_seq` on PATCH means
  "whatever the board is at now" (no concurrency check).
- **Gap recovery.** `GET /api/boards/{id}/changes?since=N` returns every
  event with `seq > N`, oldest first — this is how WS clients catch up after
  empty-op diffs, a `resync`, or a reconnect.
- **All-rejected batch:** if every op in a batch is rejected, nothing mutates:
  no seq bump, no event row, and the response carries the unchanged seq.
- Board deletion leaves no tombstone: `board_events` cascade-deletes with the
  board.

## DTOs

`Item` (`src/dto/mod.rs`) — note `type` is a plain string, never an enum, so
future item types need no API change:

```json
{
  "id": "uuid", "board_id": "uuid", "type": "image",
  "blob_hash": "64-hex | null",
  "x": 0.0, "y": 0.0, "width": 800.0, "height": 600.0,
  "rotation": 0.0,                "z_index": 3,
  "group_id": "uuid | null",
  "metadata": { },                "created_at": 1700000000000, "updated_at": 1700000000001
}
```

- `rotation` is degrees, clockwise. `metadata` is the merged `item_metadata`
  JSON payload, `{}` when absent.

Other DTOs:

| Type           | Fields                                                                                          |
|:---------------|:------------------------------------------------------------------------------------------------|
| `Board`        | `id, name, seq, viewport_state (json\|null), created_at, updated_at`                             |
| `BoardSummary` | `id, name, item_count, updated_at`                                                               |
| `Group`        | `id, board_id, parent_group_id (uuid\|null), name, collapsed, bg_color, opacity, created_at, locked` |
| `Note`         | `id, board_id, x, y, width, height, rotation, z_index, content_json, bg_color, opacity, created_at, updated_at` |
| `Tag`          | `id, name, color (string\|null)`                                                                 |
| `BlobInfo`     | `hash, original_filename, mime_type, byte_size, width?, height?, created_at, levels`             |
| `BlobLevel`    | `width, height` — one renderable scale of a blob                                                 |

`BlobInfo.levels` maps ready level names to dimensions. Image blobs expose
`full` plus generated `thumb`, `small`, and `medium` levels; skipped small
levels are aliases of `full` and still appear with the original dimensions.

## REST endpoints

### Health

| Method | Path          | Response                                  |
|:-------|:--------------|:------------------------------------------|
| GET    | `/api/health` | 200 `{ "status": "ok", "version": "…" }`  |

### Session

| Method | Path                 | Success |
|:-------|:---------------------|:--------|
| POST   | `/api/auth/session`  | 200 `{ "user_id", "token" }` plus an HttpOnly session cookie |

The token is valid only for the current server process. This is deliberately
local-first; persistent accounts and multi-user authorization remain later
work.

### Boards

| Method | Path                         | Success                 |
|:-------|:-----------------------------|:------------------------|
| POST   | `/api/boards`                | 201 `Board`             |
| GET    | `/api/boards`                | 200 `[BoardSummary]`    |
| GET    | `/api/boards/{id}`           | 200 `BoardSnapshot`     |
| PATCH  | `/api/boards/{id}`           | 200 `{seq, board}`      |
| DELETE | `/api/boards/{id}`           | 204                     |
| GET    | `/api/boards/{id}/changes`   | 200 `{seq, events}`     |

- **POST** body `{ "name": "…" }` — 400 when the trimmed name is empty.
- **GET `{id}`** is the single hydration payload (`BoardSnapshot`):
  `{board, seq, items, groups, notes, tags, item_tags, blobs}`. `items` are in
  paint order (ascending `z_index`); `item_tags` maps `item_id → [tag_id]`;
  `seq` is where the WS `since` cursor starts. 404 on unknown board.
- **PATCH** body `{ "name"?, "viewport_state"?, "client_id"? }` — `client_id`
  becomes the event/diff `origin` (echo suppression, like a batch's) so the
  sender's socket ignores its own viewport saves. `viewport_state` is a
  double option: explicit `null` resets the view, absent leaves it unchanged.
  400 on empty patch or blank name; 404 on unknown board.
- **DELETE** — 204; cascades items/groups/notes/events. 404 on unknown board.
- **GET `changes?since=N`** (`since` defaults to 0) — 200
  `{ "seq": <current board seq>, "events": [BoardEvent…] }` where
  `BoardEvent = { seq, origin (string|null), ops (json array), created_at }`.
  `ops` is the batch's op array verbatim (including rejected ops); creates and
  ingests are recorded as `[{"kind": "create", "item": Item}]` because
  `BatchOp` has no create variant. 404 on unknown board.

### Items

| Method | Path                                   | Success              |
|:-------|:---------------------------------------|:---------------------|
| POST   | `/api/boards/{id}/items`               | 201 `{seq, item}`    |
| PATCH  | `/api/boards/{id}/items/{item_id}`     | 200 `{seq, item}`    |
| DELETE | `/api/boards/{id}/items/{item_id}`     | 200 `{seq}`          |
| POST   | `/api/boards/{id}/items/batch`         | 200 `BatchResponse`  |

- **POST** body:
  `{ "type": "image", "blob_hash"?, "x", "y", "width", "height", "metadata"? }`.
  400 on non-finite geometry, non-positive width/height, or unknown
  `blob_hash`; 404 on unknown board. New items land on top of the z-stack —
  the one stack items and notes share (`max(items, notes) + 1`).
- **PATCH** body: an `ItemPatch` plus optional `base_seq` (flat, not nested):

  ```json
  { "base_seq": 42, "x": 10.0, "rotation": 90.0, "add_tag_ids": ["uuid"] }
  ```

  `ItemPatch` fields (all optional, absent = unchanged): `x, y, width,
  height, rotation, z_index, group_id, metadata, add_tag_ids, remove_tag_ids`.
  Tag assignment rides inside the patch — there are no per-tag HTTP calls.
  **`metadata` is a JSON merge patch** (RFC 7396, SQLite `json_patch`): keys
  it names are set, `null` deletes a key, every other key is kept. Clients
  send only the keys they change — never the whole object — so pipeline keys
  (`dominant_colors`, `phash`) survive client edits.
  `group_id` in a patch can only **set** a group; clearing rides the
  `set_group` batch op (plain `Option` can't distinguish absent from null).
  400 on empty patch, unknown group (`bad_request`), or unknown tag; 404 on
  unknown item/board; **409 `seq_conflict`** on stale `base_seq`.
- **DELETE** — 200 `{seq}`; 404 when the item doesn't exist on that board.
- **POST `batch`** — see the next section.

### Batch (`POST /api/boards/{id}/items/batch`)

Request (`BatchRequest`, also the client→server WS frame shape):

```json
{
  "base_seq": 42,
  "client_id": "c1",
  "ops": [ { "op_id": "uuid", "kind": "move", "item_ids": ["uuid"], "dx": 10, "dy": 5 } ]
}
```

`client_id` is the echo-suppression token: the broadcast diff's `origin` is
set to it (when non-empty) so the sender ignores its own diff. REST
single-item writes pass an empty client id and record `origin: null`.

`BatchOp` variants (`kind` is the serde tag, snake_case):

| `kind`      | Fields (besides `op_id`)            | Effect                                            |
|:------------|:------------------------------------|:--------------------------------------------------|
| `move`      | `item_ids`, `dx`, `dy`              | Relative translate of each item                   |
| `update`    | `item_id`, `fields` (`ItemPatch`)   | Apply a patch (incl. tag add/remove, metadata)    |
| `delete`    | `item_ids`                          | Delete items                                      |
| `set_group` | `item_ids`, `group_id` (nullable)   | Assign group; `null` ungroups                     |
| `set_z`     | `order` (array of item ids)         | Explicit z-order: `z_index` = position in `order` (items only — prefer `update` with `z_index`, which shares the note z space) |
| `restore_item` | `item` (full `Item`), `tag_ids`  | Insert an item with a client-chosen id (undo of delete; duplicate) |
| `put_note`  | `note` (full `Note`)                | Upsert a note (create, edit, transform, z)        |
| `delete_notes` | `note_ids`                       | Delete notes                                      |
| `restore_group` | `group` (full `Group`)          | Insert a group with a client-chosen id            |
| `remove_group` | `group_id`                       | Delete an EMPTY leaf group (`group_not_empty` otherwise) |
| `set_group_locked` | `group_id`, `locked`         | Lock / unlock a group (§6 RULE 3)                 |
| `set_group_style` | `group_id`, `bg_color` (nullable), `opacity` | Group background (`invalid_opacity` outside 0–1) |

Response (`BatchResponse`):

```json
{ "seq": 43, "applied": ["op-uuid"], "rejected": [{ "op_id": "op-uuid", "reason": "item_not_found" }] }
```

Semantics (`src/services/item_service.rs`):

- `base_seq` must equal the board's current seq → else **409 `seq_conflict`**.
- All ops validate-then-apply inside ONE transaction → ONE seq bump, ONE
  event row. Per-op validation happens **before** that op mutates, so a
  rejected op leaves no partial writes; a rejected op never aborts the batch.
- Rejection reasons: `item_not_found`, `group_not_found`, `tag_not_found`.
- The event row stores the batch **verbatim** (rejected ops included) so
  `/changes` replays exactly what the client sent; the WS diff carries only
  the ops that actually applied.
- All-rejected batch: no bump, no event, response `seq` is the unchanged
  current seq.
- 404 on unknown board.

### Groups

| Method | Path                              | Success            |
|:-------|:----------------------------------|:-------------------|
| POST   | `/api/boards/{id}/groups`         | 201 `{seq, group}` |
| PATCH  | `/api/boards/{id}/groups/{gid}`   | 200 `{seq, group}` |
| DELETE | `/api/boards/{id}/groups/{gid}`   | 204                |

- **POST** body `{ "name"?, "parent_group_id"? }` (both optional; name
  defaults to empty). 404 on unknown board; 400 when the parent is the group
  itself, doesn't exist, or belongs to another board.
- **PATCH** body `{ "name"?, "collapsed"?, "parent_group_id"? }` —
  `parent_group_id` is a double option: `null` moves the group to the root.
  400 on empty patch / bad parent; 404 when no such group on this board.
- **DELETE** — children cascade; member items are ungrouped by the schema.
  404 when no such group on this board.

### Notes

| Method | Path                            | Success           |
|:-------|:--------------------------------|:------------------|
| POST   | `/api/boards/{id}/notes`        | 201 `{seq, note}` |
| PATCH  | `/api/boards/{id}/notes/{nid}`  | 200 `{seq, note}` |
| DELETE | `/api/boards/{id}/notes/{nid}`  | 204               |

- **POST** body: `{ "x"?, "y"?, "width"*, "height"*, "rotation"?, "z_index"?,
  "content_json"?, "bg_color"?, "opacity"? }` (`*` required; `x`/`y` default
  0, `content_json` defaults `{}`, `opacity` defaults 1.0, an omitted
  `z_index` lands on top of the shared item/note stack). 404 on unknown board.
- **PATCH** body: any of `x, y, width, height, content_json, bg_color,
  opacity`. `bg_color` is a double option: `null` clears the color. 400 on
  empty patch; 404 when no such note on this board.

### Tags (global — no seq, no event log, no broadcast)

| Method | Path             | Success       | Errors                        |
|:-------|:-----------------|:--------------|:------------------------------|
| GET    | `/api/tags`      | 200 `[Tag]`   | —                             |
| POST   | `/api/tags`      | 201 `Tag`     | 400 blank name; 409 duplicate |
| PATCH  | `/api/tags/{id}` | 200 `Tag`     | 400 empty patch/blank name; 404; 409 duplicate |
| DELETE | `/api/tags/{id}` | 204           | 404                           |

- **POST** body `{ "name", "color"? }`. Names are unique case-insensitively;
  duplicates map to **409 `conflict`** (not `seq_conflict`).
- **PATCH** body `{ "name"?, "color"? }` — `color` is a double option:
  `null` clears it.
- Deleting a tag cascades its `item_tags` links. Tag **assignment** to items
  rides item patches (`add_tag_ids` / `remove_tag_ids`), never these routes.

### Ingest — `POST /api/boards/{id}/items:ingest`

Multipart upload of one or more files. The `:ingest` segment is a full
literal (axum 0.8 / matchit), so it coexists with `/items/{item_id}`.
Composition: **1 GiB body limit, no request timeout** (slow uploads must not
be killed).

**Part conventions:**

- Any part named **`meta`** is a JSON object mapping **filename → position**:
  `{ "photo.png": { "x": 100.0, "y": 40.0 } }`. Each axis is independently
  optional; a missing axis falls back to the cascade. The part may appear
  before or after the file parts. Invalid JSON → 400 `bad_request`.
- Every other part is a **file**. Files stream straight into the blob store
  (SHA-256 hashed, MIME sniffed) — never buffered whole in memory.
- Files with no `meta` entry cascade down-right from the origin in 24 px
  steps.

**Response: 202 Accepted** (accepted for processing; derivatives are async):

```json
{
  "seq": 57,
  "items": [
    {
      "item_id": "uuid",
      "blob_hash": "64-hex",
      "mime_type": "image/png",
      "width": 256.0, "height": 256.0,
      "dedup": false,
      "poster": "pending"
    }
  ]
}
```

- One entry per file, in multipart order. `seq` is the board seq after the
  last committed file (each file commits its own transaction: blob row +
  item + event + `pyramid` job, atomically — a true outbox).
- `dedup: true` when the same content hash was already in the store; the new
  item still points at the existing blob.
- `poster` is **`"pending"`** in the immediate 202 response and becomes ready
  asynchronously when the pyramid job completes.
- `width`/`height` are initial placement dimensions; the pyramid job measures
  and backfills the registered blob's intrinsic dimensions.
- Item `type` derives from the sniffed MIME: `image/…` → `image`,
  `video/…` → `video`, `audio/…` → `audio`, anything else → `file`.
- Errors: 404 unknown board, 400 invalid `meta` part, 413 over the 1 GiB
  limit. A crash between store and commit leaves at worst an unreferenced
  blob, which the GC sweeps.

### Blobs — `GET /blob/{hash}/{level}`

Content-addressed byte serving. No compression layer (media is already
compressed). `hash` is the 64-char lowercase hex SHA-256 from ingest.

| Level                    | Phase 3 behavior                                             |
|:-------------------------|:-------------------------------------------------------------|
| `full`                   | 200 — original bytes, streamed (never buffered whole)        |
| `thumb` `small` `medium` | 200 generated WebP or ready original-byte alias; pending jobs return 404 + `X-Derivative: pending` |
| anything else            | 404 (plain)                                                  |
| unknown hash             | 404 `not_found`                                              |

Successful `full` responses carry:

- `Content-Type`: the blob's sniffed MIME; `Content-Length`; and
  `X-Content-Type-Options: nosniff`.
- `Cache-Control: public, max-age=31536000, immutable` — the URL is
  content-addressed, so bytes never change.
- `ETag: "{hash}-full"` (strong). A matching `If-None-Match` (exact member or
  `*`, per RFC 9110) gets **304** with the same cache headers.

The `X-Derivative: pending` header exists so the frontend can fall back to
`full` without probing.

## WebSocket — `GET /api/boards/{id}/ws`

Query params: `client_id={uuid}` (required), `since={seq}` (optional). 404 on
unknown board. No timeout, no compression.

`since` is the client's event-log cursor; it is only **traced** server-side —
gaps between `since` and the hello seq are **not** replayed over the socket.
The client recovers them via `GET /changes?since=` over REST. (The server
subscribes before reading seq, so a client whose cursor equals the hello seq
is genuinely current.)

### Server → client envelopes

All are JSON text frames, tagged by `type` (snake_case):

| `type`   | Payload                                    | Meaning                                                        |
|:---------|:-------------------------------------------|:---------------------------------------------------------------|
| `hello`  | `{board_id, seq, server_time}`             | First frame after upgrade; `seq` is the client's new base      |
| `diff`   | `{board_id, seq, origin, ops: [BatchOp]}`  | A committed mutation                                           |
| `resync` | `{seq}`                                    | This receiver lagged past the 256-message room ring buffer     |
| `job`    | `{kind, payload}`                          | Background job progress, including `poster_ready`               |
| `error`  | `{code, message}`                          | A client→server frame was rejected (per-request, not fatal)    |

- **`diff` / echo suppression:** `origin` is the mutating client's
  `client_id` (or `null` for server-attributed REST writes). A client whose
  id matches `origin` ignores the diff — its state is already optimistic.
  `ops` contains only the **applied** ops of the batch.
- **Empty-op diffs:** creates (single POST, ingest) and board/group/note
  mutations have no `BatchOp` shape, so they broadcast `ops: []` — a pure
  seq-advance signal. The client refetches `/changes?since=` to reconcile.
- **`resync` rule:** if a receiver falls more than 256 messages behind
  (tokio broadcast `Lagged`), the server sends `resync` with the board's
  current seq **instead of dropping the socket**. The client then refetches
  `/changes?since=<its cursor>`.
- **`job`:** forward-extensible envelope, e.g.
  `{ "type": "job", "kind": "poster_ready", "payload": { "item_id": "…",
  "sizes": [64, 256, 1024] } }`. `payload` is per-kind. The Phase 3
  pyramid job emits `poster_ready` after derivative rows and files are ready.
- **`error`:** mirrors the REST envelope (`code` ∈ `not_found`,
  `seq_conflict`, `bad_request`, `too_large`, `unsupported_media`,
  `internal`). A stale `base_seq` over WS arrives as `seq_conflict`, same as
  REST.

### Client → server frames

Text frames carrying a JSON **`BatchRequest`** — the exact same shape as
`POST …/items/batch`:

```json
{ "base_seq": 42, "client_id": "c1", "ops": [ …BatchOp… ] }
```

Frames run through the same `apply_batch` machinery as REST: success is
announced by the machinery's own broadcast `diff` (no separate ack); failure
comes back as an `error` frame.

The bundled frontend does **not** write over the socket: its `BatchQueue`
posts one REST batch at a time with the seq returned by the previous one. On
`seq_conflict` it refetches and resends the same ops (they are absolute, so
they rebase cleanly; up to 3 tries), and any refetch re-applies ops still in
flight so the screen never shows a write being undone.
Pipelining several batches against the same `base_seq` gets every one after
the first rejected as `seq_conflict`, and an all-rejected batch broadcasts
no diff, so a WS writer can't tell when to send next. Malformed JSON → `bad_request` error frame;
**binary frames are rejected** (`bad_request`). Ping/pong is handled
automatically by axum.

## Phase 4+

The image pyramid is implemented in Phase 3. The frontend selects levels by
on-screen size and falls back to `full` while a requested derivative is
pending. Remaining future work includes canvas polish, broader item types, and
performance tooling.
