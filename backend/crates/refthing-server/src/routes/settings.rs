//! User settings files that live beside the database in the data folder.
//!
//! `GET /api/settings/bindings` serves `<data_dir>/bindings.toml` — the
//! user's control-scheme override (project plan: bindings are config data).
//! The client parses and validates it; the server only hands the text over.

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Router, routing::get};

use crate::auth::Principal;
use crate::error::AppResult;
use crate::state::AppState;

/// File name of the bindings override inside the data folder.
pub const BINDINGS_FILE: &str = "bindings.toml";

pub fn router() -> Router<AppState> {
    Router::new().route("/api/settings/bindings", get(bindings))
}

/// 200 `text/plain` with the override, or 204 when the user has none.
async fn bindings(_principal: Principal, State(state): State<AppState>) -> AppResult<Response> {
    let path = state.config.data_dir.join(BINDINGS_FILE);
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => {
            Ok(([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(StatusCode::NO_CONTENT.into_response())
        }
        Err(error) => Err(error.into()),
    }
}
