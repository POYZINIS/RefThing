// Wave A scaffolding: DTOs, route stubs, and the events/jobs/auth APIs exist
// for wave B to consume — until routes land they read as dead code.
// TODO(wave B): remove this allow once handlers use these APIs.
#![allow(dead_code)]

use std::sync::Arc;

use refthing_core::AppConfig;
use refthing_core::storage::BlobStore;

mod auth;
mod dto;
mod error;
mod events;
mod jobs;
mod router;
mod routes;
mod state;

use jobs::{JobContext, JobQueue, PyramidStub};
use state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = AppConfig::from_env()?;
    tokio::fs::create_dir_all(&config.data_dir).await?;

    let pools = refthing_core::db::connect(&config.data_dir.join("refthing.db")).await?;
    // BlobStore appends its own blobs/ + tmp/ subdirs, so pass the data dir
    // itself to land at data/blobs/<ab>/<cd>/<hash> per docs/data-model.md.
    let blob_store = Arc::new(BlobStore::new(config.data_dir.clone()));

    let jobs = JobQueue::new(pools.write.clone());
    jobs.register("pyramid", PyramidStub);
    let recovered = jobs.recover_running().await?;
    if recovered > 0 {
        tracing::warn!(recovered, "reset interrupted jobs to pending");
    }

    let hub = events::BroadcastHub::new();
    let job_ctx = JobContext {
        pools: pools.clone(),
        blob_store: blob_store.clone(),
        hub: hub.clone(),
    };
    let workers = JobQueue::default_worker_count();
    jobs.spawn_workers(&job_ctx, workers);
    tracing::info!(workers, "job workers started");

    let state = AppState {
        config: Arc::new(config),
        pools,
        blob_store,
        jobs,
        hub,
    };

    let addr = format!("{}:{}", state.config.host, state.config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "refthing-server listening");

    let app = router::build_router(state);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("install Ctrl+C handler");
    tracing::info!("shutdown signal received");
}
