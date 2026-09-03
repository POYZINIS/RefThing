use axum::{Router, routing::get};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::state::AppState;

pub fn build_router(state: AppState) -> Router {
    let api = Router::new().route("/health", get(health));

    Router::new()
        .nest("/api", api)
        .with_state(state)
        // Global middleware: to add auth later, insert a single
        // `.layer(auth_layer)` line alongside the layers below.
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
}

async fn health() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}
