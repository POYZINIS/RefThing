//! Local-first session authentication. The first release has one user and one
//! startup-scoped session token. It can be sent as a bearer token or the
//! `HttpOnly` `refthing_session` cookie. Requests without credentials remain
//! anonymous local requests for backwards-compatible desktop use.
use std::future::Future;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use uuid::{Uuid, uuid};

use crate::error::AppError;
use crate::state::AppState;

pub const LOCAL_USER_ID: Uuid = uuid!("019525f7-8b6c-7000-8000-000000000001");
const SESSION_COOKIE: &str = "refthing_session";

#[derive(Debug, Clone, Copy)]
pub struct Principal {
    pub user_id: Uuid,
}

impl FromRequestParts<AppState> for Principal {
    type Rejection = AppError;

    fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> {
        let supplied = bearer_token(parts).or_else(|| cookie_token(parts));
        let result = match supplied {
            Some(token) if token == state.auth_token.as_ref() => Ok(Self {
                user_id: LOCAL_USER_ID,
            }),
            Some(_) => Err(AppError::Unauthorized),
            None => Ok(Self {
                user_id: LOCAL_USER_ID,
            }),
        };
        std::future::ready(result)
    }
}

fn bearer_token(parts: &Parts) -> Option<&str> {
    parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

fn cookie_token(parts: &Parts) -> Option<&str> {
    parts
        .headers
        .get(axum::http::header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|cookie| {
                let (name, value) = cookie.trim().split_once('=')?;
                (name == SESSION_COOKIE).then_some(value)
            })
        })
}
