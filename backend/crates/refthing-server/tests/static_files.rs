//! Static SPA fallback: with `AppConfig::static_dir` set, the router serves
//! the built frontend for paths the API routes don't claim.

use std::sync::Arc;

use refthing_core::AppConfig;
use refthing_core::db;
use refthing_core::pipeline::ResizePool;
use refthing_core::storage::BlobStore;
use refthing_server::events::BroadcastHub;
use refthing_server::jobs::{JobContext, JobQueue, PyramidJob};
use refthing_server::state::AppState;

async fn spawn_app(static_dir: Option<std::path::PathBuf>) -> (String, tempfile::TempDir) {
    let dir = tempfile::tempdir().expect("temp dir");
    let config = AppConfig {
        host: "127.0.0.1".to_string(),
        port: 0,
        data_dir: dir.path().to_path_buf(),
        static_dir,
        boards_dir: None,
    };
    let pools = db::connect(&dir.path().join("refthing.db"))
        .await
        .expect("connect");
    let blob_store = Arc::new(BlobStore::new(dir.path().to_path_buf()));
    let jobs = JobQueue::new(pools.write.clone());
    jobs.register("pyramid", PyramidJob);
    let hub = BroadcastHub::new();
    let resize_pool = Arc::new(ResizePool::new());
    let job_ctx = JobContext {
        pools: pools.clone(),
        blob_store: blob_store.clone(),
        hub: hub.clone(),
        resize_pool: resize_pool.clone(),
        deriv_root: dir.path().join("deriv"),
    };
    jobs.spawn_workers(&job_ctx, 1);
    let state = AppState {
        config: Arc::new(config),
        auth_token: Arc::from("test-token"),
        pools,
        blob_store,
        jobs,
        hub,
        resize_pool,
    };

    let app = refthing_server::router::build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });

    (format!("http://{addr}"), dir)
}

#[tokio::test]
async fn static_dir_serves_index_and_spa_fallback() {
    let static_dir = tempfile::tempdir().expect("static dir");
    std::fs::write(
        static_dir.path().join("index.html"),
        "<!doctype html><title>refthing</title>",
    )
    .expect("write index");
    std::fs::create_dir_all(static_dir.path().join("assets")).expect("assets dir");
    std::fs::write(static_dir.path().join("assets/app.js"), "console.log(1)").expect("write asset");

    let (base, _dir) = spawn_app(Some(static_dir.path().to_path_buf())).await;

    let root = reqwest::get(format!("{base}/")).await.expect("GET /");
    assert_eq!(root.status(), 200);
    assert!(root.text().await.expect("body").contains("refthing"));

    let asset = reqwest::get(format!("{base}/assets/app.js"))
        .await
        .expect("GET asset");
    assert_eq!(asset.status(), 200);

    let deep = reqwest::get(format!("{base}/boards/some-deep-link"))
        .await
        .expect("GET deep link");
    assert_eq!(deep.status(), 200);
    assert!(deep.text().await.expect("body").contains("refthing"));
}

/// The page is checked on every load, so an update's new page is never
/// shadowed by a cached old one; the hash-named build files are kept for good
/// — but never a page that fell back in for a missing one.
#[tokio::test]
async fn the_page_is_always_revalidated_and_hashed_assets_kept() {
    let static_dir = tempfile::tempdir().expect("static dir");
    std::fs::write(static_dir.path().join("index.html"), "<!doctype html>").expect("index");
    std::fs::create_dir_all(static_dir.path().join("assets")).expect("assets dir");
    std::fs::write(static_dir.path().join("assets/index-AbC123.js"), "1").expect("asset");
    let (base, _dir) = spawn_app(Some(static_dir.path().to_path_buf())).await;
    let cache_control = |response: &reqwest::Response| {
        response.headers()["cache-control"]
            .to_str()
            .expect("header")
            .to_string()
    };

    for page in ["/", "/index.html", "/?v=0.3.1"] {
        let response = reqwest::get(format!("{base}{page}")).await.expect("page");
        assert_eq!(cache_control(&response), "no-cache", "{page}");
    }
    let asset = reqwest::get(format!("{base}/assets/index-AbC123.js"))
        .await
        .expect("asset");
    assert!(cache_control(&asset).contains("immutable"));
    let missing = reqwest::get(format!("{base}/assets/index-Gone99.js"))
        .await
        .expect("missing asset");
    assert_eq!(cache_control(&missing), "no-cache");
}

#[tokio::test]
async fn api_routes_take_precedence_over_static_dir() {
    let static_dir = tempfile::tempdir().expect("static dir");
    std::fs::write(static_dir.path().join("index.html"), "spa").expect("write index");

    let (base, _dir) = spawn_app(Some(static_dir.path().to_path_buf())).await;

    let health = reqwest::get(format!("{base}/api/health"))
        .await
        .expect("GET health");
    assert_eq!(health.status(), 200);
    let body: serde_json::Value = health.json().await.expect("JSON body");
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn no_static_dir_still_404s_unknown_paths() {
    let (base, _dir) = spawn_app(None).await;
    let response = reqwest::get(format!("{base}/anything")).await.expect("GET");
    assert_eq!(response.status(), 404);
}

/// The bindings override is read from the data folder on every request, so
/// editing the file takes effect on the next app load; absent file = 204.
#[tokio::test]
async fn bindings_override_is_served_from_the_data_dir() {
    let (base, dir) = spawn_app(None).await;
    let url = format!("{base}/api/settings/bindings");
    let none = reqwest::get(&url).await.expect("get");
    assert_eq!(none.status(), 204);

    std::fs::write(
        dir.path().join("bindings.toml"),
        "[keys.undo]\nkey = \"u\"\n",
    )
    .expect("write");
    let some = reqwest::get(&url).await.expect("get");
    assert_eq!(some.status(), 200);
    assert_eq!(
        some.text().await.expect("text"),
        "[keys.undo]\nkey = \"u\"\n"
    );
}
