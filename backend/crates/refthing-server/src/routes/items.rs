//! Wave B stub — see `mod.rs` for the path prefix and middleware contract.

use axum::Router;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
}
