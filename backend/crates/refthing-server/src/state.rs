use std::sync::Arc;

use refthing_core::AppConfig;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
}
