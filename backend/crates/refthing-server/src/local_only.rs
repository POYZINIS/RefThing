//! The server answers only this machine's own pages and programs.
//!
//! It listens on loopback, but a web page open in the user's browser can
//! still reach `127.0.0.1` — by sending requests to it (with its own
//! `Origin`), or by DNS rebinding (its domain re-pointed at `127.0.0.1`,
//! arriving with a foreign `Host`). Either way it would read and change
//! boards, so every request is checked:
//!
//! - `Host` must name this machine (`localhost`, `127.0.0.1`, `[::1]`, or the
//!   configured host) — a rebound domain is refused.
//! - `Origin`, when present (browsers send it on cross-origin requests,
//!   every write and every WebSocket handshake), must be a page served from
//!   this machine — another site's, or `null` (sandboxed documents,
//!   `file:`), is refused.
//!
//! No CORS headers are sent at all: the app's pages are same-origin (the
//! embedded server, or the Vite proxy in development), so nothing needs
//! them — and without them a browser won't hand any response to another
//! site.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::state::AppState;

/// A host name (no port) that is this machine.
fn is_local_name(name: &str, configured: &str) -> bool {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    matches!(name.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1")
        || (!configured.is_empty() && name.eq_ignore_ascii_case(configured))
}

/// `host[:port]` → `host` (IPv6 literals keep their brackets).
fn strip_port(authority: &str) -> &str {
    if authority.starts_with('[') {
        return authority
            .find(']')
            .map_or(authority, |end| &authority[..=end]);
    }
    authority.split(':').next().unwrap_or(authority)
}

/// Whether a request's `Host` / `Origin` headers say it comes from this
/// machine's own pages (see the module docs).
#[must_use]
pub fn allowed(host: Option<&str>, origin: Option<&str>, configured_host: &str) -> bool {
    let configured = if matches!(configured_host, "0.0.0.0" | "::") {
        ""
    } else {
        configured_host
    };
    let host_ok = host.is_none_or(|host| is_local_name(strip_port(host), configured));
    let origin_ok = origin.is_none_or(|origin| {
        let Some(rest) = origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"))
        else {
            return false;
        };
        let authority = rest.split('/').next().unwrap_or_default();
        is_local_name(strip_port(authority), configured)
    });
    host_ok && origin_ok
}

/// The middleware: 403 for anything not from this machine's own pages.
pub async fn guard(State(state): State<AppState>, request: Request<Body>, next: Next) -> Response {
    let headers = request.headers();
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    if allowed(host, origin, &state.config.host) {
        next.run(request).await
    } else {
        (StatusCode::FORBIDDEN, "RefThing only answers its own pages").into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn local_pages_and_programs_pass() {
        // A program (no browser): no Origin.
        assert!(allowed(Some("127.0.0.1:7171"), None, "127.0.0.1"));
        assert!(allowed(None, None, "127.0.0.1"));
        // The desktop app's page, and the dev server's.
        assert!(allowed(
            Some("127.0.0.1:7171"),
            Some("http://127.0.0.1:7171"),
            "127.0.0.1"
        ));
        assert!(allowed(
            Some("localhost:5173"),
            Some("http://localhost:5173"),
            "127.0.0.1"
        ));
        assert!(allowed(
            Some("[::1]:7171"),
            Some("http://[::1]:7171"),
            "127.0.0.1"
        ));
    }

    #[test]
    fn other_sites_and_rebinding_are_refused() {
        // A web page sending requests to the app.
        assert!(!allowed(
            Some("127.0.0.1:7171"),
            Some("https://evil.example"),
            "127.0.0.1"
        ));
        assert!(!allowed(Some("127.0.0.1:7171"), Some("null"), "127.0.0.1"));
        // DNS rebinding: a foreign Host (and Origin) resolving to loopback.
        assert!(!allowed(Some("evil.example:7171"), None, "127.0.0.1"));
        assert!(!allowed(
            Some("evil.example:7171"),
            Some("http://evil.example:7171"),
            "127.0.0.1"
        ));
        // Look-alikes.
        assert!(!allowed(Some("localhost.evil.example"), None, "127.0.0.1"));
        assert!(!allowed(
            Some("127.0.0.1:7171"),
            Some("http://127.0.0.1.evil.example"),
            "127.0.0.1"
        ));
        // Listening everywhere doesn't make every name local.
        assert!(!allowed(Some("evil.example"), None, "0.0.0.0"));
    }
}
