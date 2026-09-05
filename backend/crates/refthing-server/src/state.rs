use std::sync::Arc;

use refthing_core::AppConfig;
use refthing_core::db::Pools;
use refthing_core::storage::BlobStore;

use crate::events::hub::BroadcastHub;
use crate::jobs::JobQueue;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub pools: Pools,
    pub blob_store: Arc<BlobStore>,
    pub jobs: JobQueue,
    pub hub: BroadcastHub,
}
