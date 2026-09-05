//! SQLite-outbox job queue with a tokio worker pool (not apalis — see the
//! Phase 2 design: one writer, transactional enqueue, one source of truth).
//!
//! - [`JobQueue::enqueue_tx`] runs inside the caller's mutation transaction
//!   (true outbox); the caller calls [`JobQueue::notify`] after commit.
//! - Workers sleep on a `Notify` and atomically claim via
//!   `UPDATE ... WHERE id = (SELECT ...) RETURNING`, so N workers never take
//!   the same job.
//! - Failure with `attempts < MAX_ATTEMPTS` re-pends with exponential backoff
//!   (`run_after = now + 2^attempts s`); otherwise the job is `failed`.
//! - [`JobQueue::recover_running`] resets `running → pending` at startup
//!   (crash recovery). All handlers must be idempotent.
//!
//! All SQL is runtime (`sqlx::query`) to keep the `.sqlx` cache stable.

pub mod pyramid;

pub use pyramid::PyramidStub;

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use refthing_core::db::Pools;
use refthing_core::storage::BlobStore;
use sqlx::{Row, SqlitePool, SqliteTransaction};
use tokio::sync::Notify;

use crate::events::hub::BroadcastHub;

/// A job is attempted at most this many times before landing in `failed`.
pub const MAX_ATTEMPTS: i64 = 3;

const DB_ERROR_BACKOFF: Duration = Duration::from_secs(1);

/// Everything a handler needs. Clone-cheap (Arc/pool handles).
#[derive(Clone)]
pub struct JobContext {
    pub pools: Pools,
    pub blob_store: Arc<BlobStore>,
    pub hub: BroadcastHub,
}

/// A claimed job, handed to its [`JobHandler`].
#[derive(Debug, Clone)]
pub struct Job {
    pub id: i64,
    pub kind: String,
    pub payload: serde_json::Value,
    /// Number of the current attempt (1-based).
    pub attempts: i64,
}

/// Handler registry entry. Handlers must be idempotent — a crash between the
/// side effect and the `done` update replays the job.
#[async_trait::async_trait]
pub trait JobHandler: Send + Sync {
    async fn run(&self, ctx: &JobContext, job: &Job) -> anyhow::Result<()>;
}

/// Outbox queue over the write pool. Clone-cheap; clones share the notify and
/// the handler registry.
#[derive(Clone)]
pub struct JobQueue {
    write: SqlitePool,
    notify: Arc<Notify>,
    handlers: Arc<RwLock<HashMap<String, Arc<dyn JobHandler>>>>,
}

impl JobQueue {
    #[must_use]
    pub fn new(write: SqlitePool) -> Self {
        Self {
            write,
            notify: Arc::new(Notify::new()),
            handlers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Registers `handler` for `kind`. Register all handlers before spawning
    /// workers / serving traffic.
    ///
    /// # Panics
    /// Panics if the handler registry lock is poisoned.
    pub fn register(&self, kind: &str, handler: impl JobHandler + 'static) {
        self.handlers
            .write()
            .expect("handler registry poisoned")
            .insert(kind.to_string(), Arc::new(handler));
    }

    /// Inserts a job inside the caller's transaction (true outbox). Does NOT
    /// notify workers — call [`JobQueue::notify`] after the commit.
    ///
    /// # Errors
    /// Returns an error if the insert fails.
    pub async fn enqueue_tx(
        &self,
        tx: &mut SqliteTransaction<'_>,
        kind: &str,
        payload: serde_json::Value,
    ) -> Result<i64, sqlx::Error> {
        let row = sqlx::query("INSERT INTO jobs (kind, payload_json) VALUES (?, ?) RETURNING id")
            .bind(kind)
            .bind(payload.to_string())
            .fetch_one(&mut **tx)
            .await?;
        row.try_get("id")
    }

    /// Convenience wrapper: enqueues in its own transaction and notifies.
    ///
    /// # Errors
    /// Returns an error if the transaction fails.
    pub async fn enqueue(
        &self,
        kind: &str,
        payload: serde_json::Value,
    ) -> Result<i64, sqlx::Error> {
        let mut tx = self.write.begin().await?;
        let id = self.enqueue_tx(&mut tx, kind, payload).await?;
        tx.commit().await?;
        self.notify();
        Ok(id)
    }

    /// Wakes one worker. Cheap and lossy by design — workers re-check for
    /// work whenever they wake.
    pub fn notify(&self) {
        self.notify.notify_one();
    }

    /// Crash recovery: jobs left `running` by a dead process become claimable
    /// again. Call once at startup, before spawning workers.
    ///
    /// # Errors
    /// Returns an error if the update fails.
    pub async fn recover_running(&self) -> Result<u64, sqlx::Error> {
        let result = sqlx::query("UPDATE jobs SET status = 'pending' WHERE status = 'running'")
            .execute(&self.write)
            .await?;
        Ok(result.rows_affected())
    }

    /// `available_parallelism - 1`, clamped to 1..=4.
    #[must_use]
    pub fn default_worker_count() -> usize {
        std::thread::available_parallelism()
            .map_or(1, std::num::NonZero::get)
            .saturating_sub(1)
            .clamp(1, 4)
    }

    /// Spawns `workers` detached worker tasks. They run until the runtime
    /// shuts down; jobs they leave `running` are recovered at next startup.
    pub fn spawn_workers(&self, ctx: &JobContext, workers: usize) {
        for _ in 0..workers {
            let queue = self.clone();
            let ctx = ctx.clone();
            tokio::spawn(async move {
                queue.worker_loop(&ctx).await;
            });
        }
    }

    async fn worker_loop(&self, ctx: &JobContext) {
        loop {
            match self.execute_next(ctx).await {
                Ok(true) => {} // drain: re-check immediately
                Ok(false) => {
                    // Permit semantics make this race-free against notify().
                    self.notify.notified().await;
                }
                Err(error) => {
                    tracing::error!(%error, "job worker error");
                    tokio::time::sleep(DB_ERROR_BACKOFF).await;
                }
            }
        }
    }

    /// Claims and runs one job, if any is claimable. Returns `false` when the
    /// queue was empty. Exposed for tests; the worker loop drives it.
    ///
    /// # Errors
    /// Returns an error on database failure (handler failures are recorded on
    /// the job, not returned).
    ///
    /// # Panics
    /// Panics if the handler registry lock is poisoned.
    pub async fn execute_next(&self, ctx: &JobContext) -> anyhow::Result<bool> {
        let Some(job) = self.claim_one().await? else {
            return Ok(false);
        };

        // Clone the handler Arc out of the registry, then drop the guard —
        // never hold a std lock across .await.
        let handler = self
            .handlers
            .read()
            .expect("handler registry poisoned")
            .get(&job.kind)
            .cloned();
        let result = match handler {
            Some(handler) => handler.run(ctx, &job).await,
            None => Err(anyhow::anyhow!(
                "no handler registered for job kind {:?}",
                job.kind
            )),
        };

        match result {
            Ok(()) => self.mark_done(job.id).await?,
            Err(error) => {
                tracing::warn!(job_id = job.id, kind = %job.kind, attempt = job.attempts, %error, "job failed");
                self.retry_or_fail(&job).await?;
            }
        }
        Ok(true)
    }

    /// Atomically claims the oldest claimable job. The sub-select plus
    /// single-writer pool guarantee no double-claim.
    async fn claim_one(&self) -> Result<Option<Job>, sqlx::Error> {
        let now = chrono::Utc::now().timestamp_millis();
        let row = sqlx::query(
            "UPDATE jobs SET status = 'running', attempts = attempts + 1 \
             WHERE id = ( \
                 SELECT id FROM jobs \
                 WHERE status = 'pending' AND run_after <= ? \
                 ORDER BY id LIMIT 1 \
             ) RETURNING id, kind, payload_json, attempts",
        )
        .bind(now)
        .fetch_optional(&self.write)
        .await?;

        row.map(|row| {
            let payload_json: String = row.try_get("payload_json")?;
            let payload = serde_json::from_str(&payload_json)
                .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;
            Ok(Job {
                id: row.try_get("id")?,
                kind: row.try_get("kind")?,
                payload,
                attempts: row.try_get("attempts")?,
            })
        })
        .transpose()
    }

    async fn mark_done(&self, id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE jobs SET status = 'done' WHERE id = ?")
            .bind(id)
            .execute(&self.write)
            .await?;
        Ok(())
    }

    async fn retry_or_fail(&self, job: &Job) -> Result<(), sqlx::Error> {
        if job.attempts < MAX_ATTEMPTS {
            // 2^attempts seconds: 2s, 4s, then failed on the third failure.
            let backoff_ms = 1000_i64 << job.attempts;
            let run_after = chrono::Utc::now().timestamp_millis() + backoff_ms;
            sqlx::query("UPDATE jobs SET status = 'pending', run_after = ? WHERE id = ?")
                .bind(run_after)
                .bind(job.id)
                .execute(&self.write)
                .await?;
        } else {
            sqlx::query("UPDATE jobs SET status = 'failed' WHERE id = ?")
                .bind(job.id)
                .execute(&self.write)
                .await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use refthing_core::db::{self, Pools};
    use serde_json::json;

    use super::*;

    async fn temp_write_pool() -> (tempfile::TempDir, Pools) {
        let dir = tempfile::tempdir().expect("temp dir");
        let pools = db::connect(&dir.path().join("test.db"))
            .await
            .expect("connect");
        (dir, pools)
    }

    fn test_context(pools: &Pools) -> JobContext {
        JobContext {
            pools: pools.clone(),
            blob_store: Arc::new(BlobStore::new(std::path::PathBuf::from("unused"))),
            hub: BroadcastHub::new(),
        }
    }

    async fn job_row(pool: &SqlitePool, id: i64) -> (String, i64, i64) {
        let row = sqlx::query("SELECT status, attempts, run_after FROM jobs WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("job row");
        (
            row.try_get("status").expect("status"),
            row.try_get("attempts").expect("attempts"),
            row.try_get("run_after").expect("run_after"),
        )
    }

    struct OkHandler {
        calls: Arc<AtomicUsize>,
    }

    #[async_trait::async_trait]
    impl JobHandler for OkHandler {
        async fn run(&self, _ctx: &JobContext, _job: &Job) -> anyhow::Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    struct FailHandler;

    #[async_trait::async_trait]
    impl JobHandler for FailHandler {
        async fn run(&self, _ctx: &JobContext, _job: &Job) -> anyhow::Result<()> {
            Err(anyhow::anyhow!("boom"))
        }
    }

    #[tokio::test]
    async fn enqueue_claim_done_lifecycle() {
        let (_dir, pools) = temp_write_pool().await;
        let queue = JobQueue::new(pools.write.clone());
        let calls = Arc::new(AtomicUsize::new(0));
        queue.register(
            "ok",
            OkHandler {
                calls: calls.clone(),
            },
        );

        let id = queue.enqueue("ok", json!({"n": 1})).await.expect("enqueue");
        assert!(
            queue
                .execute_next(&test_context(&pools))
                .await
                .expect("run")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(job_row(&pools.read, id).await.0, "done");

        // Queue drained: nothing left to claim.
        assert!(
            !queue
                .execute_next(&test_context(&pools))
                .await
                .expect("run")
        );
    }

    #[tokio::test]
    async fn enqueue_tx_participates_in_caller_transaction() {
        let (_dir, pools) = temp_write_pool().await;
        let queue = JobQueue::new(pools.write.clone());

        let mut tx = pools.write.begin().await.expect("begin");
        queue
            .enqueue_tx(&mut tx, "ok", json!({}))
            .await
            .expect("enqueue in tx");
        tx.rollback().await.expect("rollback");

        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM jobs")
            .fetch_one(&pools.read)
            .await
            .expect("count");
        assert_eq!(count, 0, "rolled-back enqueue leaves no job");
    }

    #[tokio::test]
    async fn failing_handler_retries_with_backoff_then_fails() {
        let (_dir, pools) = temp_write_pool().await;
        let queue = JobQueue::new(pools.write.clone());
        queue.register("fail", FailHandler);

        let id = queue.enqueue("fail", json!({})).await.expect("enqueue");
        let ctx = test_context(&pools);

        assert!(queue.execute_next(&ctx).await.expect("run 1"));
        let (status, attempts, run_after) = job_row(&pools.read, id).await;
        assert_eq!((status.as_str(), attempts), ("pending", 1));
        assert!(run_after > chrono::Utc::now().timestamp_millis());

        // Not claimable again until run_after passes.
        assert!(!queue.execute_next(&ctx).await.expect("not yet claimable"));

        // Force claimability for attempts 2 and 3.
        for expected_attempts in [2, 3] {
            sqlx::query("UPDATE jobs SET run_after = 0 WHERE id = ?")
                .bind(id)
                .execute(&pools.write)
                .await
                .expect("force claimable");
            assert!(queue.execute_next(&ctx).await.expect("retry"));
            let (status, attempts, _) = job_row(&pools.read, id).await;
            assert_eq!(attempts, expected_attempts);
            if expected_attempts < MAX_ATTEMPTS {
                assert_eq!(status, "pending");
            } else {
                assert_eq!(status, "failed");
            }
        }
    }

    #[tokio::test]
    async fn unknown_kind_becomes_failed_path() {
        let (_dir, pools) = temp_write_pool().await;
        let queue = JobQueue::new(pools.write.clone());
        let id = queue.enqueue("mystery", json!({})).await.expect("enqueue");
        assert!(
            queue
                .execute_next(&test_context(&pools))
                .await
                .expect("run")
        );
        // Attempt 1 of 3: re-pended like any other failure.
        assert_eq!(job_row(&pools.read, id).await.0, "pending");
    }

    #[tokio::test]
    async fn startup_recovery_releases_running_jobs() {
        let (_dir, pools) = temp_write_pool().await;
        let queue = JobQueue::new(pools.write.clone());
        let id = queue.enqueue("ok", json!({})).await.expect("enqueue");
        sqlx::query("UPDATE jobs SET status = 'running' WHERE id = ?")
            .bind(id)
            .execute(&pools.write)
            .await
            .expect("simulate crash");

        let recovered = queue.recover_running().await.expect("recover");
        assert_eq!(recovered, 1);
        assert_eq!(job_row(&pools.read, id).await.0, "pending");
    }

    #[tokio::test]
    async fn pyramid_stub_marks_success() {
        let (_dir, pools) = temp_write_pool().await;
        let queue = JobQueue::new(pools.write.clone());
        queue.register("pyramid", PyramidStub);
        let id = queue
            .enqueue("pyramid", json!({"blob_hash": "ab", "mime": "image/png"}))
            .await
            .expect("enqueue");
        assert!(
            queue
                .execute_next(&test_context(&pools))
                .await
                .expect("run")
        );
        assert_eq!(job_row(&pools.read, id).await.0, "done");
    }

    #[test]
    fn worker_count_is_clamped() {
        let count = JobQueue::default_worker_count();
        assert!((1..=4).contains(&count));
    }
}
