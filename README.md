# RefThing

A web-based, PureRef-style reference board: thousands of images on a WebGL
canvas (PixiJS) at 60fps, backed by a Rust/axum server. React frontend,
Rust backend, monorepo workspaces.

## Prerequisites

See [docs/prerequisites.md](docs/prerequisites.md) for the required toolchain
(Rust stable with rustfmt + clippy, Node 24, npm).

## Quickstart

```sh
npm install
npm run dev
```

Then open <http://localhost:5173>.

`npm run dev` starts both the axum API (`dev:api`) and the Vite dev server
(`dev:web`) side by side via `concurrently`.

## Useful scripts

| Command             | What it does                                    |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Run API + web dev servers together              |
| `npm run dev:api`   | Run the backend only (plain `cargo run`; use `cargo-watch` if you want auto-reload — see docs) |
| `npm run dev:web`   | Run the frontend only                           |
| `npm run lint`      | Biome check + `cargo clippy`                    |
| `npm run fmt`       | Biome format + `cargo fmt`                      |
| `npm run typecheck` | TypeScript typecheck of the frontend            |
