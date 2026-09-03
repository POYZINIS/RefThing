# ADR 0001: Foundation stack

**Status:** Accepted
**Date:** 2025 (Phase 0 foundation)

## Context

RefThing is a high-performance web-based reference board: thousands of
images on a canvas at 60fps. Phase 0 needs a foundation stack that is
verified-installable on Windows 11 + Git Bash today, and that will not
need to be re-litigated in later phases.

## Decision

### Verified pins

| Layer | Choice | Version |
|:------|:-------|:--------|
| Rust toolchain | stable, MSVC | 1.98, edition 2024 |
| Node | LTS | 24 (26 verified working) |
| Build tool | Vite (Rolldown) | 8 |
| React plugin | @vitejs/plugin-react (Oxc) | 6 |
| UI library | React | 19.2 |
| Language | TypeScript | ~7.0 (fallback: TS 6.0 if dependency types choke) |
| Styling | Tailwind CSS, CSS-first config | v4 |
| Lint/format | Biome | 2.5 |
| HTTP server | axum + tower-http | 0.8 |
| Database layer | sqlx (SQLite) | 0.8.6, **pinned** |
| Canvas engine | pixi.js | ^8.19 (introduced Phase 4) |
| Spatial index | rbush | 4 |
| Client state | zustand | 5 |

sqlx is pinned to **0.8.6**: 0.9 is too new — the repository moved to
transact-rs and shipped breaking `SqlSafeStr` changes. Stay on 0.8.6 until
the ecosystem settles.

### Rejected alternatives

| Rejected | In favor of | Reason |
|:---------|:------------|:-------|
| ESLint + Prettier | Biome | One binary, one config. Accepted risk: Biome's react-hooks rules are weaker than eslint-plugin-react-hooks. |
| @pixi/react | Imperative Pixi mount | Reconciler overhead for zero benefit — the canvas is not declarative UI. |
| pixi-viewport / Pixi CullerPlugin | Hand-rolled camera + rbush | Unmaintained v7-era plugins; we need the visible item list (not just render culling) for selection, lodging, and network sync. |
| WebGPU | WebGL2 | WebGPU is immature in pixi 8.x; revisit in Phase 9. |
| apalis | Custom SQLite outbox queue | Phase 2; keeps single-writer discipline and gives transactional enqueue with the rest of the write. |
| sqlx 0.9 | sqlx 0.8.6 | Stability (see above). |

## Consequences

- One lint/format tool, one config file, one CI step (`npx biome ci .`).
- The canvas engine has no React in its render path — see the core
  invariant in `docs/architecture.md`.
- Camera, culling, and the visible-item set are first-class engine code we
  own and can test.
- The job queue is a table in the same SQLite database; enqueueing is
  atomic with the write that motivates the job.
