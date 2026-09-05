//! HTTP error type: every handler returns [`AppResult`], and [`AppError`]
//! renders as `{"error": {"code", "message"}}` with the matching status.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0} not found")]
    NotFound(&'static str),
    /// e.g. batch `base_seq` mismatch — the client refetches changes and rebases.
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("payload too large")]
    TooLarge,
    #[error("unsupported media type: {0}")]
    UnsupportedMedia(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    code: &'static str,
    message: String,
}

impl AppError {
    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            Self::NotFound(_) | Self::Db(sqlx::Error::RowNotFound) => {
                (StatusCode::NOT_FOUND, "not_found")
            }
            Self::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            Self::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            Self::TooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "too_large"),
            Self::UnsupportedMedia(_) => (StatusCode::UNSUPPORTED_MEDIA_TYPE, "unsupported_media"),
            Self::Db(_) | Self::Io(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = self.status_and_code();
        if status == StatusCode::INTERNAL_SERVER_ERROR {
            tracing::error!(error = %self, "internal error");
        }
        let body = ErrorBody {
            error: ErrorDetail {
                code,
                message: self.to_string(),
            },
        };
        (status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status_of(error: AppError) -> StatusCode {
        error.into_response().status()
    }

    #[test]
    fn variant_status_codes() {
        assert_eq!(
            status_of(AppError::NotFound("board")),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status_of(AppError::Conflict("base_seq mismatch".to_string())),
            StatusCode::CONFLICT
        );
        assert_eq!(
            status_of(AppError::BadRequest("nope".to_string())),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(status_of(AppError::TooLarge), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            status_of(AppError::UnsupportedMedia("text/plain".to_string())),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            status_of(AppError::Io(std::io::Error::other("boom"))),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn sqlx_row_not_found_maps_to_404() {
        let error = AppError::Db(sqlx::Error::RowNotFound);
        assert_eq!(status_of(error), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn body_is_error_envelope() {
        let response = AppError::NotFound("board").into_response();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body bytes");
        let json: serde_json::Value = serde_json::from_slice(&bytes).expect("json");
        assert_eq!(json["error"]["code"], "not_found");
        assert_eq!(json["error"]["message"], "board not found");
    }
}
