//! STUB pyramid handler (Phase 3 lands the real pipeline). Marks success
//! without generating derivatives — clients keep rendering `full` until then.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{Job, JobContext, JobHandler};

/// Enqueued by ingest, one per stored file. Consumed by the Phase 3 pyramid
/// pipeline (poster/derivative generation); the stub below ignores it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PyramidPayload {
    /// SHA-256 of the ingested blob (`blobs.hash` / blob-store key).
    pub blob_hash: String,
    /// MIME type sniffed at ingest.
    pub mime: String,
    /// Item the derivatives belong to.
    pub item_id: Uuid,
}

pub struct PyramidStub;

#[async_trait]
impl JobHandler for PyramidStub {
    // async_trait requires `async`; the stub has nothing to await.
    #[allow(clippy::unused_async)]
    async fn run(&self, _ctx: &JobContext, job: &Job) -> anyhow::Result<()> {
        tracing::debug!(job_id = job.id, payload = %job.payload, "pyramid stub: no-op");
        Ok(())
    }
}
