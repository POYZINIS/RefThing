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
