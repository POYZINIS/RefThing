//! STUB pyramid handler (Phase 3 lands the real pipeline). Marks success
//! without generating derivatives — clients keep rendering `full` until then.

use async_trait::async_trait;

use super::{Job, JobContext, JobHandler};

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
