use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, extract::State};
use serde_json::json;

use crate::auth::LOCAL_USER_ID;
use crate::state::AppState;

const SESSION_COOKIE: &str = "refthing_session";

pub fn router() -> Router<AppState> {
    Router::new().route("/api/auth/session", axum::routing::post(create_session))
}

async fn create_session(State(state): State<AppState>) -> Response {
    let mut response = Json(json!({
        "user_id": LOCAL_USER_ID,
        "token": state.auth_token.as_ref(),
    }))
    .into_response();
    let cookie = format!(
        "{SESSION_COOKIE}={}; HttpOnly; SameSite=Lax; Path=/",
        state.auth_token
    );
    response.headers_mut().insert(
        header::SET_COOKIE,
        cookie.parse().expect("session cookie is valid header text"),
    );
    response
}
