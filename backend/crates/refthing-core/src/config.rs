use std::path::PathBuf;

use crate::error::CoreError;

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 7171;
pub const DEFAULT_DATA_DIR: &str = "./data";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppConfig {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    /// Directory with a built frontend to serve as an SPA fallback (the
    /// desktop app points this at the bundled `frontend/dist`; plain server
    /// deployments leave it unset).
    pub static_dir: Option<PathBuf>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            host: DEFAULT_HOST.to_string(),
            port: DEFAULT_PORT,
            data_dir: PathBuf::from(DEFAULT_DATA_DIR),
            static_dir: None,
        }
    }
}

impl AppConfig {
    /// Builds a config from `REFTHING_HOST`, `REFTHING_PORT`,
    /// `REFTHING_DATA_DIR` and `REFTHING_STATIC_DIR` environment variables,
    /// falling back to defaults.
    ///
    /// # Errors
    /// Returns [`CoreError::Config`] if `REFTHING_PORT` is not a valid `u16`.
    pub fn from_env() -> Result<Self, CoreError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, CoreError> {
        let mut config = Self::default();

        if let Some(host) = lookup("REFTHING_HOST").filter(|v| !v.is_empty()) {
            config.host = host;
        }

        if let Some(port) = lookup("REFTHING_PORT").filter(|v| !v.is_empty()) {
            config.port = port.parse::<u16>().map_err(|source| CoreError::Config {
                key: "REFTHING_PORT".to_string(),
                value: port,
                source,
            })?;
        }

        if let Some(dir) = lookup("REFTHING_DATA_DIR").filter(|v| !v.is_empty()) {
            config.data_dir = PathBuf::from(dir);
        }

        if let Some(dir) = lookup("REFTHING_STATIC_DIR").filter(|v| !v.is_empty()) {
            config.static_dir = Some(PathBuf::from(dir));
        }

        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lookup_from<'a>(
        vars: &'a [(&'a str, &'a str)],
    ) -> impl Fn(&str) -> Option<String> + use<'a> {
        move |key| {
            vars.iter()
                .find(|(k, _)| *k == key)
                .map(|(_, v)| (*v).to_string())
        }
    }

    #[test]
    fn defaults_are_applied() {
        let config = AppConfig::default();
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 7171);
        assert_eq!(config.data_dir, PathBuf::from("./data"));
        assert_eq!(config.static_dir, None);
    }

    #[test]
    fn missing_env_vars_fall_back_to_defaults() {
        let config = AppConfig::from_lookup(|_| None).expect("config loads");
        assert_eq!(config, AppConfig::default());
    }

    #[test]
    fn env_overrides_defaults() {
        let vars = [
            ("REFTHING_HOST", "0.0.0.0"),
            ("REFTHING_PORT", "8080"),
            ("REFTHING_DATA_DIR", "/tmp/refthing-test"),
        ];
        let config = AppConfig::from_lookup(lookup_from(&vars)).expect("config loads");
        assert_eq!(config.host, "0.0.0.0");
        assert_eq!(config.port, 8080);
        assert_eq!(config.data_dir, PathBuf::from("/tmp/refthing-test"));
    }

    #[test]
    fn empty_env_vars_are_ignored() {
        let vars = [("REFTHING_HOST", ""), ("REFTHING_PORT", "")];
        let config = AppConfig::from_lookup(lookup_from(&vars)).expect("config loads");
        assert_eq!(config, AppConfig::default());
    }

    #[test]
    fn static_dir_is_loaded_from_env() {
        let vars = [("REFTHING_STATIC_DIR", "frontend/dist")];
        let config = AppConfig::from_lookup(lookup_from(&vars)).expect("config loads");
        assert_eq!(config.static_dir, Some(PathBuf::from("frontend/dist")));

        let vars = [("REFTHING_STATIC_DIR", "")];
        let config = AppConfig::from_lookup(lookup_from(&vars)).expect("config loads");
        assert_eq!(config.static_dir, None);
    }

    #[test]
    fn invalid_port_is_rejected() {
        let vars = [("REFTHING_PORT", "not-a-port")];
        let result = AppConfig::from_lookup(lookup_from(&vars));
        assert!(matches!(result, Err(CoreError::Config { .. })));
    }
}
