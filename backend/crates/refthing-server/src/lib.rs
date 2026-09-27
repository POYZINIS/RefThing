//! `RefThing` server library. `main.rs` is a thin shim over [`run`]; all logic
//! lives here so integration tests (`tests/`) and the binary share one
//! compilation of every module.

// Lets modules inside this crate refer to it as `refthing_server::...`
// (same path the integration tests use).
extern crate self as refthing_server;

pub mod auth;
pub mod dto;
pub mod error;
pub mod events;
pub mod item_types;
pub mod jobs;
pub mod router;
pub mod routes;
pub mod services;
pub mod state;

use std::sync::Arc;

use refthing_core::AppConfig;
use refthing_core::pipeline::ResizePool;
use refthing_core::storage::BlobStore;
use uuid::Uuid;

use crate::jobs::{JobContext, JobQueue, PyramidJob};
use crate::state::AppState;

/// Boot the server: config → DB → blob store → job workers → HTTP/WS listener.
///
/// # Errors
/// Returns on config parse failure, DB connection/migration failure, or bind
/// failure.
pub async fn run() -> anyhow::Result<()> {
    run_with_shutdown(AppConfig::from_env()?, shutdown_signal()).await
}

/// Boot the server with an explicit config and shutdown trigger. Used by the
/// desktop app, which embeds the server in-process and shuts it down when the
/// window closes.
///
/// # Errors
/// Returns on DB connection/migration failure or bind failure.
pub async fn run_with_shutdown(
    config: AppConfig,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init()
        .ok();

    tokio::fs::create_dir_all(&config.data_dir).await?;

    let pools = refthing_core::db::connect(&config.data_dir.join("refthing.db")).await?;
    // Background WAL checkpoint: keeps the WAL file bounded regardless of
    // write activity (Phase 7 reliability).
    let _checkpoint_handle = refthing_core::db::spawn_checkpoint_task(pools.clone());
    // BlobStore appends its own blobs/ + tmp/ subdirs, so pass the data dir
    // itself to land at data/blobs/<ab>/<cd>/<hash> per docs/data-model.md.
    let blob_store = Arc::new(BlobStore::new(config.data_dir.clone()));

    let jobs = JobQueue::new(pools.write.clone());
    jobs.register("pyramid", PyramidJob);
    jobs.register("media_poster", jobs::media_poster::MediaPosterJob);
    let recovered = jobs.recover_running().await?;
    if recovered > 0 {
        tracing::warn!(recovered, "reset interrupted jobs to pending");
    }

    // Models dropped before 3D support landed as file cards: upgrade them.
    match services::model_service::retype_models(&pools, &blob_store).await {
        Ok(0) => {}
        Ok(changed) => tracing::info!(changed, "file items recognized as 3D models"),
        Err(error) => tracing::warn!(%error, "model retyping skipped"),
    }

    let hub = events::BroadcastHub::new();
    let resize_pool = Arc::new(ResizePool::new());
    let job_ctx = JobContext {
        pools: pools.clone(),
        blob_store: blob_store.clone(),
        hub: hub.clone(),
        resize_pool: resize_pool.clone(),
        deriv_root: config.data_dir.join("deriv"),
    };
    let workers = JobQueue::default_worker_count();
    jobs.spawn_workers(&job_ctx, workers);
    tracing::info!(workers, "job workers started");

    let state = AppState {
        config: Arc::new(config),
        auth_token: Arc::from(Uuid::now_v7().to_string()),
        pools,
        blob_store,
        jobs,
        hub,
        resize_pool,
    };

    let addr = format!("{}:{}", state.config.host, state.config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr, "refthing-server listening");

    let app = router::build_router(state);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("install Ctrl+C handler");
    tracing::info!("shutdown signal received");
}
