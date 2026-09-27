# Architecture

## Module map

```
RefThing/
├── backend/                  # Rust workspace
│   ├── crates/
│   │   ├── refthing-core/    # domain types, board model, business logic (no I/O)
│   │   └── refthing-server/  # axum HTTP + WebSocket server, SQLite persistence
│   └── Cargo.toml
├── frontend/                 # React + PixiJS app (Vite)
│   └── src/
│       ├── main.tsx          # entry; mounts React shell
│       ├── canvas/           # PixiJS engine: mounts once into #canvas-host, imperative
│       ├── components/       # UI chrome only (floating toolbars, popovers, sheets)
│       ├── ui/               # chrome primitives: icons, popover, motion, appearance
│       ├── shell/            # desktop (Tauri) window bridge — inert in a browser
│       ├── state/            # zustand stores
│       └── api/              # HTTP + WebSocket client for the backend
├── sidecar/                  # Node service for Node-only rendering (stub until Phase 11)
└── docs/
```

- **refthing-core** — pure domain logic, no framework or database imports.
  Everything testable lives here.
- **refthing-server** — thin shell: HTTP/WebSocket transport, SQLite via
  sqlx, wiring core logic to the outside world.
- **frontend/src/canvas** — the PixiJS engine. Owns the canvas and all
  board rendering; updated imperatively, not through React.

## Frontend board pipeline

```
pointer ─► NodeInteractionController (canvas presses: select, drag, box select)
        └► SelectionOverlay (DOM shell over the selection: zones, gestures)
                 │ pointer samples
                 ▼
           canvas/transform.ts  (pure gesture math: move, resize, rotate,
                 │               flip, aspect reset — unit-tested)
                 ▼ NodeChange[]
App.commitBoardOps ─► state/history.ts prepareCommand (inverse ops, no-ops
                 │    dropped; one entry per gesture) ─► undo stack
                 ▼
           optimistic applyOps  +  api/batchQueue.ts (ONE REST batch in
                                   flight, each with the current base_seq)
WebSocket (api/ws.ts) is receive-only: other clients' diffs and job events.
```

- **Every node kind is a canvas sprite.** Images, GIFs and notes share one
  scene graph and one paint order (`z_index` is a single space across items
  and notes; ties break by kind then id). Notes paint through
  `NoteTextureSource` from a `@chenglou/pretext` layout; only the note being
  edited swaps to a DOM textarea (`NoteEditor`) showing the raw text in the
  note's font. Notes render markdown (`canvas/nodes/markdown.ts` → blocks,
  laid out by pretext rich-inline in `noteText.ts`) and carry a style in
  `content_json.style`; unfilled notes take the theme's flipped text colour,
  so note textures key on the theme and repaint when it changes.
- **DOM chrome positions from the rendered camera.** Pixi eases the camera;
  `BoardCanvas` publishes the camera it actually painted each frame
  (`onRenderedViewportChange`, committed synchronously) and every overlay
  uses it. `canvas/coordinates.ts` is the one screen↔world converter.
- **Stacking** is one CSS ladder (`index.css`): canvas < note editor < hover
  outline < selection shell < drawing < floating chrome < menus.
- **Commands** (`state/commands.ts`) are pure snapshot+selection → ops
  functions shared by the keyboard map (`canvas/controls.ts`) and the
  context menu.
- **Item types** (Phase 11): backend `item_types.rs` handlers pick type,
  placement and poster job per sniffed MIME; the frontend maps `type` to a
  node kind (`canvas/nodes/itemKind.ts`) drawn from a pyramid poster or a
  `CardTextureSource` card. A lone selected video/audio item mounts
  `components/MediaPlayer.tsx`: the media element on the editor rung and
  custom controls above the selection shell (`--z-media-controls`), each
  revealed by its own `useProximityReveal`. See `docs/onboarding-new-item-type.md`.
- **3D models** (`type = model`: GLB / glTF / FBX / `.blend`): rendered by
  the client, not the server. `canvas/model/modelWorker.ts` is a Web Worker
  owning one WebGL context (three.js on an OffscreenCanvas): it parses the
  file (`modelLoad.ts`), bakes every mesh into world-space buffers bucketed
  by base-colour texture (one draw call per texture), and renders a cheap
  diffuse shader with back-face culling; the sky is a separate pass drawn
  only where the depth buffer is empty, so Background off is transparent
  and lights the model identically. Renders come back as ImageBitmaps that
  `ModelTextureSource` turns into the item's sprite texture (so z-order,
  culling and the selection shell are unchanged); settled renders are
  cached in IndexedDB (`posterCache.ts`) so a board of models reopens
  without loading any. Per-item view settings (`item_metadata.model`,
  `canvas/nodes/modelView.ts`) are merge-patched like any metadata;
  `components/ModelOrbit.tsx` is orbit mode. `.blend` files reach the
  worker as GLB via `GET /blob/{hash}/model` (headless Blender, server side,
  `services/model_service.rs`).
- **Colour** (`src/color/`): `harmony.ts` (conversions, the nine
  harmonies, the random generator), `sample.ts` (k-means++ palette
  extraction in OKLab), `items.ts` (the blob-less `palette` / `colorwheel`
  items: metadata, `restore_item` construction, swatch hit-testing, the
  end-to-end join), `wheelLayout.ts` (one layout for the canvas painting
  and the live panel). `canvas/nodes/ColorTextureSources.ts` paints both
  kinds; `components/ColorWheelPanel.tsx` is the wheel's live controls
  (iro.js), shown only while it is the lone selection.
- **Board import** (`refthing-core/src/pureref.rs`, `POST /api/boards:import`):
  a PureRef 2 `.pur` is a displaced SQLite database of Qt-serialized items;
  the core reads it into placements and the server commits them through the
  same ingest / note paths as a drop. The frontend routes any dropped,
  chosen or pasted `.pur` there (`isBoardFile` in `api/client.ts`).
- **sidecar** — internal Node helper for puppeteer embed screenshots
  (Phase 11+; 3D models no longer need it — the client renders them). See `sidecar/README.md` and
  `docs/onboarding-new-item-type.md`.

## Chrome (UI around the board)

The board takes the whole window and is clean at rest: the corner groups
fade out until the pointer comes near (`ui/useProximityReveal.ts`, pinned
by CSS while a panel they opened is up or they hold keyboard focus). See
`DESIGN.md`.

- **Top left** — the board switcher (`components/BoardSwitcher.tsx`: list,
  new, rename, delete, snapshots), Add files, the theme toggle, Settings
  (`SettingsSheet.tsx`: appearance, scroll zoom speed, tags, shortcut
  reference).
- **Search** (`SearchBar.tsx`) has no fixed place: Search… in the canvas
  context menu (or Ctrl+F) opens it as a popover at that point. A filter
  outlives the panel; while one holds, a pill top centre shows the match
  count with Edit / Clear.
- **Top right** — desktop window controls (`WindowControls.tsx`), absent in
  the browser.
- **Bottom centre** — nothing but a status line while a board opens, files
  upload or a board imports. (The saved-views API remains server-side with
  no UI; the canvas's grayscale shader has no toggle.)

Popovers (`ui/Popover.tsx`) portal to `<body>`. Preferences (theme, glass,
backdrop opacity, scroll zoom speed) live in `ui/appearance.ts` and applies as attributes on
`<html>`; `index.html` sets the saved theme before first paint. The Pixi
canvas is transparent, so the themed workspace (and, on desktop, the Acrylic
backdrop) sits behind it and a theme switch never repaints the board.

**Desktop shell** (`src-tauri`): a frameless, transparent window. The page
reaches the window through the global Tauri API (`shell/desktop.ts`); the
page is served over HTTP, so `main.rs` grants window permissions to exactly
that origin at runtime. The top strip is the drag region, and a right-drag
on the board moves the window (`move_window` in `canvas/bindings.ts`).

## Ports

| Port | Service             | Notes                        |
|-----:|:--------------------|:-----------------------------|
| 7171 | Backend API (axum)  | HTTP + WebSocket             |
| 5173 | Vite dev server     | Proxies API calls to 7171    |
| 7272 | Sidecar stub        | 501 everywhere until Phase 11|

## The core invariant

**React owns UI chrome only and NEVER renders the canvas.**

PixiJS mounts **once** into `#canvas-host` and from then on is updated
imperatively (pan/zoom, item add/remove/transform, selection outlines —
all via direct engine calls). React renders the toolbar, panels, dialogs,
and other chrome around the canvas, and communicates with the engine
through an explicit API (commands in, events out). No React component ever
touches canvas contents; there is no React reconciler in the render loop.

## Auth (slot-in plan)

v1 is **local-first**: a single local user, no auth on any endpoint. Auth
is designed to slot in later without restructuring:

- **HTTP**: one axum middleware + a `Principal` extractor. Routes keep
  taking `Principal` (v1: a trivial always-local implementation), so adding
  real auth changes only the middleware.
- **WebSocket**: browser WebSockets cannot send custom headers, so WS auth
  will need a cookie-based session or a short-lived ticket obtained over
  HTTP and presented in the WS handshake URL/subprotocol. Do not design
  the WS protocol assuming `Authorization` headers will ever be available.
