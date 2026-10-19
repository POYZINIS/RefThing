//! End-to-end API tests for saved views (Phase 6): CRUD round-trips, board
//! scoping, validation, and the viewport wire-shape.

use std::sync::Arc;

use refthing_core::AppConfig;
use refthing_core::db;
use refthing_core::pipeline::ResizePool;
use refthing_core::storage::BlobStore;
use refthing_server::events::BroadcastHub;
use refthing_server::jobs::{JobContext, JobQueue, PyramidJob};
use refthing_server::state::AppState;
use serde_json::{Value, json};
use uuid::Uuid;

struct TestApp {
    base: String,
    _dir: tempfile::TempDir,
}

async fn spawn_app() -> TestApp {
    let dir = tempfile::tempdir().expect("temp dir");
    let config = AppConfig {
        host: "127.0.0.1".to_string(),
        port: 0,
        data_dir: dir.path().to_path_buf(),
        static_dir: None,
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

    let app = refthing_server::router::build_router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });

    TestApp {
        base: format!("http://{addr}"),
        _dir: dir,
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

async fn create_board(app: &TestApp, name: &str) -> Value {
    let response = client()
        .post(format!("{}/api/boards", app.base))
        .json(&json!({"name": name}))
        .send()
        .await
        .expect("create board");
    assert_eq!(response.status(), 201);
    response.json().await.expect("board json")
}

fn id_of(resource: &Value) -> &str {
    resource["id"].as_str().expect("id string")
}

async fn get_json(app: &TestApp, path: &str) -> Value {
    let response = client()
        .get(format!("{}{path}", app.base))
        .send()
        .await
        .expect("get");
    assert_eq!(response.status(), 200, "GET {path}");
    response.json().await.expect("json")
}

async fn expect_status(app: &TestApp, method: &str, path: &str, body: Option<&Value>, status: u16) {
    let mut request = client().request(
        method.parse().expect("method"),
        format!("{}{path}", app.base),
    );
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.expect("send");
    assert_eq!(
        response.status().as_u16(),
        status,
        "{method} {path} -> {}",
        response.status()
    );
}

#[tokio::test]
async fn views_crud_round_trip() {
    let app = spawn_app().await;
    let board = create_board(&app, "views board").await;
    let board_id = id_of(&board);

    // Empty list initially.
    let empty = get_json(&app, &format!("/api/boards/{board_id}/views")).await;
    assert_eq!(empty.as_array().expect("array").len(), 0);

    // Create a view with a viewport.
    let viewport = json!({ "x": 120.5, "y": -40.0, "zoom": 1.75 });
    let created = client()
        .post(format!("{}/api/boards/{board_id}/views", app.base))
        .json(&json!({ "name": "closeup", "viewport": viewport }))
        .send()
        .await
        .expect("create view");
    assert_eq!(created.status(), 201);
    let created: Value = created.json().await.expect("view json");
    let view_id = id_of(&created);
    assert_eq!(created["name"], "closeup");
    assert_eq!(created["viewport"]["x"], 120.5);
    assert_eq!(created["viewport"]["zoom"], 1.75);
    assert!(created["created_at"].as_i64().expect("epoch ms") > 0);

    // List shows the new view.
    let listed = get_json(&app, &format!("/api/boards/{board_id}/views")).await;
    let views = listed.as_array().expect("array");
    assert_eq!(views.len(), 1);
    assert_eq!(views[0]["name"], "closeup");

    // Rename it.
    let renamed = client()
        .patch(format!(
            "{}/api/boards/{board_id}/views/{view_id}",
            app.base
        ))
        .json(&json!({ "name": "micro" }))
        .send()
        .await
        .expect("rename view");
    assert_eq!(renamed.status(), 200);
    let renamed: Value = renamed.json().await.expect("rename json");
    assert_eq!(renamed["name"], "micro");

    // Delete it; list is empty again.
    let deleted = client()
        .delete(format!(
            "{}/api/boards/{board_id}/views/{view_id}",
            app.base
        ))
        .send()
        .await
        .expect("delete view");
    assert_eq!(deleted.status(), 204);
    let empty_after = get_json(&app, &format!("/api/boards/{board_id}/views")).await;
    assert_eq!(empty_after.as_array().expect("array").len(), 0);
}

#[tokio::test]
async fn views_are_board_scoped() {
    let app = spawn_app().await;
    let alpha = create_board(&app, "alpha").await;
    let beta = create_board(&app, "beta").await;

    let created = client()
        .post(format!("{}/api/boards/{}/views", app.base, id_of(&alpha)))
        .json(&json!({ "name": "only-alpha", "viewport": { "x": 0, "y": 0, "zoom": 1 } }))
        .send()
        .await
        .expect("create view");
    assert_eq!(created.status(), 201);

    // beta sees none of alpha's views.
    let beta_views = get_json(&app, &format!("/api/boards/{}/views", id_of(&beta))).await;
    assert_eq!(beta_views.as_array().expect("array").len(), 0);
    let alpha_views = get_json(&app, &format!("/api/boards/{}/views", id_of(&alpha))).await;
    assert_eq!(alpha_views.as_array().expect("array").len(), 1);
}

#[tokio::test]
async fn views_validate_input() {
    let app = spawn_app().await;
    let board = create_board(&app, "validation").await;
    let board_id = id_of(&board);
    let base = format!("/api/boards/{board_id}/views");

    // Empty name rejects.
    expect_status(
        &app,
        "POST",
        &base,
        Some(&json!({ "name": "  ", "viewport": { "x": 0, "y": 0, "zoom": 1 } })),
        400,
    )
    .await;

    // Non-object viewport rejects.
    expect_status(
        &app,
        "POST",
        &base,
        Some(&json!({ "name": "bad", "viewport": [1, 2] })),
        400,
    )
    .await;

    // Rename with empty name rejects.
    let created = client()
        .post(format!("{}{base}", app.base))
        .json(&json!({ "name": "ok", "viewport": { "x": 0, "y": 0, "zoom": 1 } }))
        .send()
        .await
        .expect("create view");
    assert_eq!(created.status(), 201);
    let created_json = created.json().await.expect("view json");
    let view_id = id_of(&created_json);
    expect_status(
        &app,
        "PATCH",
        &format!("{base}/{view_id}"),
        Some(&json!({ "name": "" })),
        400,
    )
    .await;

    // Unknown view id returns 404.
    let bogus = Uuid::now_v7().to_string();
    expect_status(&app, "DELETE", &format!("{base}/{bogus}"), None, 404).await;
    expect_status(
        &app,
        "PATCH",
        &format!("{base}/{bogus}"),
        Some(&json!({ "name": "x" })),
        404,
    )
    .await;
}
