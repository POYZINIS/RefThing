//! Auth stub. `RefThing` v1 is local-first single-user: [`Principal`] always
//! resolves to a hardcoded local user. Write handlers take `Principal` as an
//! extractor today so real auth later is ONE middleware swap (validate a
//! session/JWT, insert `Principal` into request extensions, and switch this
//! extractor to read the extension) — routes, services, and the WS protocol
//! stay unchanged.

use std::convert::Infallible;
use std::future::Future;

use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use uuid::{Uuid, uuid};

use crate::state::AppState;

/// The one and only v1 user.
pub const LOCAL_USER_ID: Uuid = uuid!("019525f7-8b6c-7000-8000-000000000001");

#[derive(Debug, Clone, Copy)]
pub struct Principal {
    pub user_id: Uuid,
}

impl FromRequestParts<AppState> for Principal {
    type Rejection = Infallible;

    fn from_request_parts(
        _parts: &mut Parts,
        _state: &AppState,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> {
        std::future::ready(Ok(Self {
            user_id: LOCAL_USER_ID,
        }))
    }
}
