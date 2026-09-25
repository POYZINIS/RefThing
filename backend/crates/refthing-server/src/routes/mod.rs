//! Route sub-routers, one file per resource. Wave B fills these in WITHOUT
//! touching `router.rs`/`main.rs`.
//!
//! Contract for every module: `pub fn router() -> Router<AppState>` with FULL
//! paths (no nesting happens at composition time):
//!
//! | module    | paths                         | middleware applied at composition        |
//! |-----------|-------------------------------|------------------------------------------|
//! | `boards`  | `/api/boards...`              | `TimeoutLayer`(30s) + `CompressionLayer` |
//! | `items`   | `/api/boards/{id}/items...`   | `TimeoutLayer`(30s) + `CompressionLayer` |
//! | `groups`  | `/api/boards/{id}/groups...`  | `TimeoutLayer`(30s) + `CompressionLayer` |
//! | `notes`   | `/api/boards/{id}/notes...`   | `TimeoutLayer`(30s) + `CompressionLayer` |
//! | `tags`    | `/api/tags...`                | `TimeoutLayer`(30s) + `CompressionLayer` |
//! | `ingest`  | `/api/boards/{id}/items:ingest` | `DefaultBodyLimit` 1 GiB; NO timeout   |
//! | `ws`      | `/api/boards/{id}/ws`         | none (timeout would kill the socket)     |
//! | `blobs`   | `/blob/{hash}/{level}`        | none (no compression on media bytes)     |
//!
//! axum 0.8 path syntax is `/{id}` (NOT `/:id`).

pub mod auth;
pub mod blobs;
pub mod boards;
pub mod groups;
pub mod ingest;
pub mod items;
pub mod notes;
pub mod search;
pub mod settings;
pub mod snapshots;
pub mod tags;
pub mod views;
pub mod ws;
