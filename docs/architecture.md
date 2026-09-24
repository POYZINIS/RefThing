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
│       ├── components/       # UI chrome only (toolbar, panels, dialogs)
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
  edited swaps to a DOM textarea (`NoteEditor`) with identical metrics.
- **DOM chrome positions from the rendered camera.** Pixi eases the camera;
  `BoardCanvas` publishes the camera it actually painted each frame
  (`onRenderedViewportChange`, committed synchronously) and every overlay
  uses it. `canvas/coordinates.ts` is the one screen↔world converter.
- **Stacking** is one CSS ladder (`index.css`): canvas < note editor < hover
  outline < selection shell < drawing < floating chrome < menus.
- **Commands** (`state/commands.ts`) are pure snapshot+selection → ops
  functions shared by the keyboard map (`canvas/controls.ts`) and the
  context menu.
- **sidecar** — internal Node helper for three.js GLB poster snapshots and
  puppeteer embed screenshots (Phase 11+). See `sidecar/README.md` and
  `docs/onboarding-new-item-type.md`.

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
