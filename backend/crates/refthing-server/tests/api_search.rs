//! End-to-end API tests for FTS5 full-text search (Phase 6).

use std::sync::Arc;

use refthing_core::AppConfig;
use refthing_core::db;
use refthing_core::db::items::NewItem;
use refthing_core::pipeline::ResizePool;
use refthing_core::storage::BlobStore;
use refthing_server::events::BroadcastHub;
use refthing_server::jobs::{JobContext, JobQueue, PyramidJob};
use refthing_server::state::AppState;
use serde_json::{Value, json};

struct TestApp {
    base: String,
    dir: tempfile::TempDir,
}

async fn spawn_app() -> TestApp {
    let dir = tempfile::tempdir().expect("temp dir");
    let config = AppConfig {
        host: "127.0.0.1".to_string(),
        port: 0,
        data_dir: dir.path().to_path_buf(),
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
        dir,
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

async fn connect_pools(app: &TestApp) -> db::Pools {
    db::connect(&app.dir.path().join("refthing.db"))
        .await
        .expect("connect")
}

async fn insert_image(
    pools: &db::Pools,
    board_id: &str,
    blob_hash: &str,
    filename: &str,
) -> refthing_core::models::Item {
    let _ = db::blobs::insert_or_ignore(
        &pools.write,
        blob_hash,
        Some(filename),
        "image/png",
        100,
        Some(100),
        Some(100),
    )
    .await
    .expect("create blob");

    db::items::create(
        &pools.write,
        NewItem {
            board_id: board_id.parse().expect("uuid"),
            item_type: "image".to_string(),
            blob_id: Some(blob_hash.to_string()),
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            rotation: 0.0,
            z_index: 0,
            group_id: None,
        },
    )
    .await
    .expect("create item")
}

async fn insert_metadata_item(
    app: &TestApp,
    board_id: &str,
    blob_hash: &str,
    filename: &str,
    metadata: serde_json::Value,
) -> refthing_core::models::Item {
    let pools = connect_pools(app).await;
    let item = insert_image(&pools, board_id, blob_hash, filename).await;

    // Upsert item_metadata directly — the pyramid job would normally do this.
    sqlx::query(
        "INSERT INTO item_metadata (item_id, json) VALUES (?, ?)
         ON CONFLICT(item_id) DO UPDATE SET json = excluded.json",
    )
    .bind(item.id)
    .bind(metadata.to_string())
    .execute(&pools.write)
    .await
    .expect("insert metadata");
    item
}

#[tokio::test]
async fn search_finds_filename() {
    let app = spawn_app().await;
    let board = create_board(&app, "search test").await;
    let board_id = id_of(&board);

    let blob_hash = "1111111111111111111111111111111111111111111111111111111111111111";
    let pools = connect_pools(&app).await;
    let item = insert_image(&pools, board_id, blob_hash, "special_photo.png").await;

    let results = client()
        .get(format!(
            "{}/api/boards/{board_id}/search?q=special",
            app.base
        ))
        .send()
        .await
        .expect("search");
    assert_eq!(results.status(), 200);
    let results: Value = results.json().await.expect("search json");
    let results = results.as_array().expect("array");
    assert!(!results.is_empty(), "expected a result for 'special'");
    let first = &results[0];
    assert_eq!(first["item_id"], item.id.to_string());
    assert_eq!(first["kind"], "filename");
    assert!(first["snippet"].as_str().unwrap().contains("special"));
}

#[tokio::test]
async fn search_finds_note_text() {
    let app = spawn_app().await;
    let board = create_board(&app, "search notes").await;
    let board_id = id_of(&board);

    let pools = connect_pools(&app).await;
    let note = refthing_core::db::notes::create(
        &pools.write,
        board_id.parse().expect("uuid"),
        0.0,
        0.0,
        200.0,
        100.0,
        serde_json::json!({ "text": "super_duper_unique_marker" }),
    )
    .await
    .expect("create note");

    let results = client()
        .get(format!(
            "{}/api/boards/{board_id}/search?q=super_duper",
            app.base
        ))
        .send()
        .await
        .expect("search");
    assert_eq!(results.status(), 200);
    let results: Value = results.json().await.expect("search json");
    let results = results.as_array().expect("array");
    assert!(!results.is_empty(), "expected a result for 'super_duper'");
    let first = &results[0];
    assert_eq!(first["item_id"], note.id.to_string());
    assert_eq!(first["kind"], "note");
    assert!(first["snippet"].as_str().unwrap().contains("super_duper"));
}

#[tokio::test]
async fn search_finds_tags() {
    let app = spawn_app().await;
    let board = create_board(&app, "search tags").await;
    let board_id = id_of(&board);

    let blob_hash = "2222222222222222222222222222222222222222222222222222222222222222";
    let pools = connect_pools(&app).await;
    let item = insert_image(&pools, board_id, blob_hash, "tagged_item.jpg").await;

    let tag = refthing_core::db::tags::create(&pools.write, "rare_tag_xyz", Some("#ff0000"))
        .await
        .expect("create tag");
    refthing_core::db::tags::add_to_item(&pools.write, item.id, tag.id)
        .await
        .expect("add tag");

    let results = client()
        .get(format!(
            "{}/api/boards/{board_id}/search?q=rare_tag",
            app.base
        ))
        .send()
        .await
        .expect("search");
    assert_eq!(results.status(), 200);
    let results: Value = results.json().await.expect("search json");
    let results = results.as_array().expect("array");
    assert!(!results.is_empty(), "expected a result for 'rare_tag'");
    let first = &results[0];
    assert_eq!(first["item_id"], item.id.to_string());
    // The tag name is concatenated into the filename-kind row.
    assert!(first["snippet"].as_str().unwrap().contains("rare_tag"));
}

#[tokio::test]
async fn search_colour_finds_matching_items() {
    let app = spawn_app().await;
    let board = create_board(&app, "colour test").await;
    let board_id = id_of(&board);

    // Red-ish image.
    let red = insert_metadata_item(
        &app,
        board_id,
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "red.png",
        json!({ "dominant_colors": ["#ff0000", "#ff4444"], "phash": "0000000000000000" }),
    )
    .await;

    // Blue image — should NOT match #ff0000.
    insert_metadata_item(
        &app,
        board_id,
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "blue.png",
        json!({ "dominant_colors": ["#0000ff"] }),
    )
    .await;

    let results = client()
        .get(format!(
            "{}/api/boards/{board_id}/search-colour?colour=%23ff0000",
            app.base
        ))
        .send()
        .await
        .expect("search colour");
    assert_eq!(results.status(), 200);
    let results: Value = results.json().await.expect("search json");
    let results = results.as_array().expect("array");
    assert_eq!(results.len(), 1, "expected exactly one red match");
    assert_eq!(results[0]["item_id"], red.id.to_string());
    assert_eq!(results[0]["kind"], "colour");
}

#[tokio::test]
async fn duplicates_find_near_identical_phash() {
    let app = spawn_app().await;
    let board = create_board(&app, "dupe test").await;
    let board_id = id_of(&board);

    // Two items with identical phash → should be flagged.
    let a = insert_metadata_item(
        &app,
        board_id,
        "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "a.png",
        json!({ "phash": "0000000000000000" }),
    )
    .await;
    let b = insert_metadata_item(
        &app,
        board_id,
        "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        "b.png",
        json!({ "phash": "0000000000000010" }), // 1 bit different
    )
    .await;

    // A third, very different image.
    insert_metadata_item(
        &app,
        board_id,
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "c.png",
        json!({ "phash": "ffffffffffffffff" }),
    )
    .await;

    let results = client()
        .get(format!("{}/api/boards/{board_id}/duplicates", app.base))
        .send()
        .await
        .expect("duplicates");
    assert_eq!(results.status(), 200);
    let results: Value = results.json().await.expect("dupes json");
    let results = results.as_array().expect("array");
    // Both a and b should appear (a lists b; b lists a — one-directional
    // pairing means only the earlier item reports the pair).
    let ids: Vec<&str> = results
        .iter()
        .filter_map(|r| r["item_id"].as_str())
        .collect();
    assert!(
        ids.contains(&a.id.to_string().as_str()),
        "a should be flagged"
    );
    assert!(
        !ids.contains(&b.id.to_string().as_str()),
        "b is the later item"
    );
}

// ---------------------------------------------------------------------------
// Snapshot tests (Phase 7)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn snapshot_capture_list_restore() {
    let app = spawn_app().await;
    let board = create_board(&app, "snap test").await;
    let board_id = id_of(&board);
    let base = &app.base;

    // Insert an image item so the snapshot has content to capture.
    let pools = connect_pools(&app).await;
    let _item = insert_image(
        &pools,
        board_id,
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "test.png",
    )
    .await;

    // Capture a snapshot.
    let resp = client()
        .post(format!("{base}/api/boards/{board_id}/snapshots"))
        .json(&json!({"label": "before cleanup"}))
        .send()
        .await
        .expect("capture snapshot");
    assert_eq!(resp.status(), 201);
    let snap: Value = resp.json().await.expect("snapshot json");
    assert_eq!(snap["board_id"], board_id);
    assert_eq!(snap["label"], "before cleanup");
    let created_at = snap["created_at"].as_i64().expect("created_at");

    // List snapshots — should contain exactly one entry.
    let resp = client()
        .get(format!("{base}/api/boards/{board_id}/snapshots"))
        .send()
        .await
        .expect("list snapshots");
    assert_eq!(resp.status(), 200);
    let list: Vec<Value> = resp.json().await.expect("snapshots array");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["created_at"], created_at);

    // Restore the snapshot (board has the item, so restoring should succeed
    // without error — it re-inserts the same item).
    let resp = client()
        .post(format!(
            "{base}/api/boards/{board_id}/snapshots/{created_at}/restore"
        ))
        .send()
        .await
        .expect("restore snapshot");
    assert_eq!(resp.status(), 200);
    let body: Value = resp.json().await.expect("restore json");
    assert_eq!(body["status"], "restored");
}

#[tokio::test]
async fn snapshot_prunes_old_versions() {
    let app = spawn_app().await;
    let board = create_board(&app, "prune test").await;
    let board_id = id_of(&board);
    let base = &app.base;

    // Capture 12 snapshots — PRUNE_KEEP is 10, so 2 should be pruned.
    for i in 0..12 {
        let resp = client()
            .post(format!("{base}/api/boards/{board_id}/snapshots"))
            .json(&json!({"label": format!("v{i}")}))
            .send()
            .await
            .expect("capture");
        assert_eq!(resp.status(), 201);
    }

    let resp = client()
        .get(format!("{base}/api/boards/{board_id}/snapshots"))
        .send()
        .await
        .expect("list");
    let list: Vec<Value> = resp.json().await.expect("array");
    assert!(
        list.len() <= 10,
        "expected ≤10 snapshots after pruning, got {}",
        list.len()
    );
}
