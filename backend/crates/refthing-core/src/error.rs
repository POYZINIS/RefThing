use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("invalid config value for {key}: {value}")]
    Config {
        key: String,
        value: String,
        #[source]
        source: std::num::ParseIntError,
    },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Db(String),
    /// Input the caller supplied that cannot be used (e.g. an unreadable
    /// import file); the message is safe to show to the user.
    #[error("{0}")]
    InvalidInput(String),
}
