# AGENTS.md — RefThing

A high-performance web-based reference board: thousands of images on a
WebGL canvas at 60fps. Rust/axum backend, React/PixiJS frontend, Node
sidecar (stub until Phase 11). See `RefThing_Project_Plan.txt` for the
product spec and `docs/architecture.md` for the module map.

## Commands

| Task | Command |
|:-----|:--------|
| **Start the desktop app** (double-click; rebuilds first if sources changed) | `RefThing.bat` |
| **Start the Tauri dev window** (double-click; hot reload, repo `data/`) | `RefThing Dev.bat` |
| Run frontend dev server | `npm run dev` |
| Run desktop app (Tauri window) | `npm run dev:app` |
| Build desktop app (installer) | `npm run build:app` |
| Frontend unit tests (transform math, commands, history, filters) | `npm test` |
| Browser gesture tests (boots its own isolated stack on 7191/5191 with a temp data dir; set `BASE_URL` to target a running one) | `npm run test:e2e` |
| Lint frontend (Biome) | `npm run lint` |
| Format frontend (Biome) | `npm run fmt` |
| Backend tests | `cargo test --manifest-path backend/Cargo.toml --workspace` |
| Backend lint | `cargo clippy --manifest-path backend/Cargo.toml --workspace --all-targets -- -D warnings` |
| Backend format | `cargo fmt --all --manifest-path backend/Cargo.toml` |
| Backend format check | `cargo fmt --all --manifest-path backend/Cargo.toml -- --check` |

## Repo layout

```
backend/            Rust workspace
  crates/
    refthing-core/  domain types + business logic (no I/O)
    refthing-server/ axum HTTP/WS server + SQLite persistence
  migrations/       SQL migrations — embedded, run at startup (Phase 1)
frontend/           React + PixiJS app (Vite)
  src/canvas/       PixiJS engine — imperative, owns the canvas
  src/canvas/nodes/ unified node model (BoardNode), kind registry, texture
                    sources (pyramid/GIF/note), sprite renderer; notes paint on
                    the canvas via pretext (noteText.ts) in the same z order
                    as images. NodeInteractionController is the ONE pointer
                    state machine; canvas/transform.ts is the pure gesture math
  src/components/   UI chrome only (toolbar, panels, dialogs)
  src/state/        zustand stores; history.ts = command/undo engine
                    (prepareCommand + applyBoardOps — applyOps delegates to it);
                    commands.ts = pure board commands (group, duplicate, ...)
  src/api/          HTTP + WebSocket client; batchQueue.ts = the ONE write
                    path (one REST batch in flight); ws.ts is receive-only
frontend/tests/     node:test unit suites + gesture-paths.mjs (canonical
                    motion primitives from the testing conventions)
frontend/e2e/       Playwright browser suites (isolated seeded boards)
sidecar/            Node service for Node-only rendering (stub until Phase 11)
src-tauri/          Tauri desktop app (standalone crate, NOT in the backend
                    workspace) — embeds refthing-server in-process; the webview
                    loads the app over HTTP from the embedded server itself
docs/               architecture, prerequisites, ADRs, onboarding guides
data/               local state (SQLite DB, uploads) — NEVER commit
```

## Invariants

- **React owns UI chrome only and NEVER renders the canvas.** PixiJS
  mounts once into `#canvas-host` and is updated imperatively.
- Ports: backend API **7171**, Vite dev server **5173**, sidecar **7272**.
- `data/` holds local state (SQLite database, uploaded files). It is
  gitignored and must **never be committed**.
- The root **`.cargo/config.toml` is machine-local (gitignored) and
  required for linking on this box** — it has no MSVC toolchain, so all
  linking goes through the shim in `backend/target/`. Do not commit it,
  and note that `cargo clean` deletes the shim. See
  `docs/prerequisites.md` → "No-MSVC machines".
- Items and notes share ONE `z_index` space (the canvas interleaves them).
  Item `metadata` updates are JSON merge patches — send only changed keys.
- Browser tests must create their own boards; never clean up by deleting
  content on a board the test didn't create.
- SQLite migrations live in **`backend/migrations/`** and run **embedded
  at startup** (`sqlx::migrate!()`), forward-only. See
  `docs/data-model.md` for the schema and its invariants (no `CHECK` on
  `items.type`, SHA-256 blob hashes, zip export as the only backup path).

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main`:

- `rust` job on ubuntu + windows: `cargo fmt --check`, `clippy -D warnings`,
  `cargo test`, all against `backend/Cargo.toml`.
- `frontend` job on ubuntu: `npm ci`, `npx biome ci .`, typecheck, build.

From **Phase 1** the Rust job sets **`SQLX_OFFLINE=true`** — sqlx
compile-time checked queries build against the committed offline cache
(`backend/.sqlx/`), so CI needs no live database. After changing any
`query!`/`query_as!` call, regenerate the cache:

```sh
cd backend && SQLX_OFFLINE=false DATABASE_URL=sqlite:./data/dev.db cargo sqlx prepare --workspace
```

(requires `sqlx-cli` 0.8.x and a migrated throwaway `backend/data/dev.db`;
both gitignored). Commit the updated `backend/.sqlx/` with the change.
