# AGENTS.md — RefThing

A high-performance web-based reference board: thousands of images on a
WebGL canvas at 60fps. Rust/axum backend, React/PixiJS frontend, Node
sidecar (stub until Phase 11). See `RefThing_Project_Plan.txt` for the
product spec and `docs/architecture.md` for the module map.

## Commands

| Task | Command |
|:-----|:--------|
| Run frontend dev server | `npm run dev` |
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
frontend/           React + PixiJS app (Vite)
  src/canvas/       PixiJS engine — imperative, owns the canvas
  src/components/   UI chrome only (toolbar, panels, dialogs)
  src/state/        zustand stores
  src/api/          HTTP + WebSocket client
sidecar/            Node service for Node-only rendering (stub until Phase 11)
docs/               architecture, prerequisites, ADRs, onboarding guides
data/               local state (SQLite DB, uploads) — NEVER commit
```

## Invariants

- **React owns UI chrome only and NEVER renders the canvas.** PixiJS
  mounts once into `#canvas-host` and is updated imperatively.
- Ports: backend API **7171**, Vite dev server **5173**, sidecar **7272**.
- `data/` holds local state (SQLite database, uploaded files). It is
  gitignored and must **never be committed**.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main`:

- `rust` job on ubuntu + windows: `cargo fmt --check`, `clippy -D warnings`,
  `cargo test`, all against `backend/Cargo.toml`.
- `frontend` job on ubuntu: `npm ci`, `npx biome ci .`, typecheck, build.

From **Phase 1** onward the Rust job sets **`SQLX_OFFLINE=true`** (sqlx
compile-time checked queries use the checked-in offline metadata, so CI
needs no live database).
