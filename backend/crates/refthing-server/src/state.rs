use std::sync::Arc;

use refthing_core::AppConfig;
use refthing_core::db::Pools;
use refthing_core::pipeline::ResizePool;
use refthing_core::storage::BlobStore;

use crate::events::hub::BroadcastHub;
use crate::jobs::JobQueue;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    /// Startup-scoped local session token. v1 remains single-user, but all
    /// authenticated requests pass through the same principal boundary.
    pub auth_token: Arc<str>,
    pub pools: Pools,
    pub blob_store: Arc<BlobStore>,
    pub jobs: JobQueue,
    pub hub: BroadcastHub,
    /// Shared with the job workers; kept on the state so routes can offload
    /// image work to the same dedicated rayon pool.
    pub resize_pool: Arc<ResizePool>,
}
