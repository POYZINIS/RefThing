//! Dedicated rayon pool for CPU-bound image work.
//!
//! Resize/decode/encode must never run on `tokio::task::spawn_blocking`: the
//! blocking pool is for short blocking I/O, and long CPU work there starves
//! real blocking calls with no backpressure. The bridge to tokio is a
//! oneshot channel per job.

/// Rayon pool sized to `available_parallelism - 1` (at least 1), threads
/// named `img-<n>`. One pool serves the whole process.
pub struct ResizePool {
    pool: rayon::ThreadPool,
}

impl ResizePool {
    /// Builds the pool.
    ///
    /// # Panics
    /// Panics if rayon fails to spawn the threads (only possible under OS
    /// resource exhaustion).
    #[must_use]
    pub fn new() -> Self {
        let threads =
            std::thread::available_parallelism().map_or(1, |n| n.get().saturating_sub(1).max(1));
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|index| format!("img-{index}"))
            .build()
            .expect("failed to build image resize thread pool");
        Self { pool }
    }

    /// Runs `f` on the pool and awaits its result without blocking a tokio
    /// worker thread.
    ///
    /// # Panics
    /// Panics if the closure panics on the pool thread (the oneshot sender
    /// is dropped without a value).
    pub async fn run<F, T>(&self, f: F) -> T
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pool.spawn(move || {
            let _ = tx.send(f());
        });
        rx.await.expect("resize worker panicked")
    }
}

impl Default for ResizePool {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn run_executes_the_closure_and_returns_its_value() {
        let pool = ResizePool::new();
        assert_eq!(pool.run(|| 40 + 2).await, 42);
    }

    #[tokio::test]
    async fn run_executes_on_an_img_thread() {
        let pool = ResizePool::new();
        let thread_name = pool
            .run(|| std::thread::current().name().unwrap_or("").to_string())
            .await;
        assert!(
            thread_name.starts_with("img"),
            "unexpected thread name: {thread_name}"
        );
    }

    #[tokio::test]
    async fn run_survives_concurrent_jobs() {
        let pool = ResizePool::new();
        let mut handles = Vec::new();
        for value in 0..16u32 {
            let future = pool.run(move || value * 2);
            handles.push((value, future));
        }
        for (value, future) in handles {
            assert_eq!(future.await, value * 2);
        }
    }
}
