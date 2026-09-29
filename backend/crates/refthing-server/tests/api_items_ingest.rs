//! API tests for items, batch, and ingest (Phase 2 wave B).
//!
//! Each test spawns the full router on an ephemeral port against a tempdir
//! SQLite database + blob store, with the pyramid stub worker running.

use std::sync::Arc;
use std::time::Duration;

use refthing_core::db::boards;
use refthing_core::pipeline::ResizePool;
use refthing_core::storage::BlobStore;
use refthing_core::{AppConfig, db};
use refthing_server::dto::ops::{BatchOp, BatchRequest, ItemPatch};
use refthing_server::events;
use refthing_server::events::hub::ServerMsg;
use refthing_server::jobs::{JobContext, JobQueue, PyramidJob};
use refthing_server::state::AppState;
use serde_json::{Value, json};
use uuid::Uuid;

/// Minimal valid 1x1 PNG (sniffed by `infer` as `image/png`).
const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

struct TestApp {
    base_url: String,
    state: AppState,
    client: reqwest::Client,
    _dir: tempfile::TempDir,
}

/// Boots the full router against a tempdir database + blob store, with the
/// pyramid worker running, on an ephemeral port.
async fn spawn_app() -> TestApp {
    let dir = tempfile::tempdir().expect("temp dir");
    let data_dir = dir.path().to_path_buf();
    let config = AppConfig {
        host: "127.0.0.1".to_string(),
        port: 0,
        data_dir: data_dir.clone(),
        static_dir: None,
        boards_dir: None,
    };
    let pools = db::connect(&data_dir.join("refthing.db"))
        .await
        .expect("connect");
    let blob_store = Arc::new(BlobStore::new(data_dir.clone()));
    let job_queue = JobQueue::new(pools.write.clone());
    job_queue.register("pyramid", PyramidJob);
    let hub = events::BroadcastHub::new();
    let resize_pool = Arc::new(ResizePool::new());
    let job_ctx = JobContext {
        pools: pools.clone(),
        blob_store: blob_store.clone(),
        hub: hub.clone(),
        resize_pool: resize_pool.clone(),
        deriv_root: data_dir.join("deriv"),
    };
    job_queue.spawn_workers(&job_ctx, 1);

    let app_state = AppState {
        config: Arc::new(config),
        auth_token: Arc::from("test-token"),
        pools,
        blob_store,
        jobs: job_queue,
        hub,
        resize_pool,
    };
    let app = refthing_server::router::build_router(app_state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    TestApp {
        base_url: format!("http://{addr}"),
        state: app_state,
        client: reqwest::Client::new(),
        _dir: dir,
    }
}

async fn make_board(app: &TestApp) -> Uuid {
    boards::create(&app.state.pools.write, "board")
        .await
        .expect("create board")
        .id
}

/// Inserts `n` 10x10 items at the origin in one transaction; returns ids.
async fn insert_items(app: &TestApp, board_id: Uuid, n: usize) -> Vec<Uuid> {
    let mut tx = app.state.pools.write.begin().await.expect("begin");
    let mut ids = Vec::with_capacity(n);
    for _ in 0..n {
        let id = Uuid::now_v7();
        sqlx::query(
            "INSERT INTO items (id, board_id, type, width, height) VALUES (?, ?, 'image', 10, 10)",
        )
        .bind(id)
        .bind(board_id)
        .execute(&mut *tx)
        .await
        .expect("insert item");
        ids.push(id);
    }
    tx.commit().await.expect("commit");
    ids
}

async fn board_seq(app: &TestApp, board_id: Uuid) -> i64 {
    boards::get(&app.state.pools.read, board_id)
        .await
        .expect("get board")
        .expect("board exists")
        .seq
}

async fn wait_for_done_jobs(app: &TestApp, expected: i64) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let (done,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM jobs WHERE status = 'done'")
            .fetch_one(&app.state.pools.read)
            .await
            .expect("count jobs");
        if done >= expected {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "jobs did not drain: {done}/{expected} done"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines)]
async fn create_patch_delete_item() {
    let app = spawn_app().await;
    let board_id = make_board(&app).await;

    // Create without a blob.
    let response = app
        .client
        .post(format!("{}/api/boards/{board_id}/items", app.base_url))
        .json(&json!({"type": "image", "x": 1.0, "y": 2.0, "width": 100.0, "height": 50.0}))
        .send()
        .await
        .expect("create");
    assert_eq!(response.status(), reqwest::StatusCode::CREATED);
    let body: Value = response.json().await.expect("body");
    assert_eq!(body["seq"], 1);
    assert_eq!(body["item"]["type"], "image");
    assert_eq!(body["item"]["z_index"], 0);
    let item_id = Uuid::parse_str(body["item"]["id"].as_str().expect("id")).expect("uuid");

    // Create from a registered blob.
    let blob = app.state.blob_store.put(PNG_1X1).await.expect("put blob");
    refthing_core::db::blobs::insert_or_ignore(
        &app.state.pools.write,
        &blob.hash,
        Some("ref.png"),
        &blob.mime,
        i64::try_from(blob.byte_size).expect("size fits"),
        None,
        None,
    )
    .await
    .expect("register blob");
    let response = app
        .client
        .post(format!("{}/api/boards/{board_id}/items", app.base_url))
        .json(&json!({
            "type": "image",
            "blob_hash": blob.hash,
            "x": 0.0, "y": 0.0, "width": 64.0, "height": 64.0,
        }))
        .send()
        .await
        .expect("create from blob");
    assert_eq!(response.status(), reqwest::StatusCode::CREATED);
    let body: Value = response.json().await.expect("body");
    assert_eq!(body["seq"], 2);
    assert_eq!(body["item"]["blob_hash"], json!(blob.hash));
    assert_eq!(body["item"]["z_index"], 1, "stacks on top");

    // Unknown blob hash is a 400.
    let response = app
        .client
        .post(format!("{}/api/boards/{board_id}/items", app.base_url))
        .json(&json!({
            "type": "image",
            "blob_hash": "f".repeat(64),
            "x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0,
        }))
        .send()
        .await
        .expect("create unknown blob");
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);

    // Patch geometry + a tag (base_seq supplied and current).
    let tag = refthing_core::db::tags::create(&app.state.pools.write, "mood", None)
        .await
        .expect("create tag");
    let response = app
        .client
        .patch(format!(
            "{}/api/boards/{board_id}/items/{item_id}",
            app.base_url
        ))
        .json(&json!({"base_seq": 2, "x": 10.0, "rotation": 90.0, "add_tag_ids": [tag.id]}))
        .send()
        .await
        .expect("patch");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.expect("body");
    assert_eq!(body["seq"], 3);
    assert_eq!(body["item"]["x"], 10.0);
    assert_eq!(body["item"]["rotation"], 90.0);
    let tags = refthing_core::db::tags::list_for_item(&app.state.pools.read, item_id)
        .await
        .expect("tags");
    assert_eq!(tags.len(), 1);

    // Stale base_seq → 409 seq_conflict.
    let response = app
        .client
        .patch(format!(
            "{}/api/boards/{board_id}/items/{item_id}",
            app.base_url
        ))
        .json(&json!({"base_seq": 1, "x": 99.0}))
        .send()
        .await
        .expect("patch stale");
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
    let body: Value = response.json().await.expect("body");
    assert_eq!(body["error"]["code"], "seq_conflict");
    assert_eq!(board_seq(&app, board_id).await, 3, "conflict bumps nothing");

    // Delete.
    let response = app
        .client
        .delete(format!(
            "{}/api/boards/{board_id}/items/{item_id}",
            app.base_url
        ))
        .send()
        .await
        .expect("delete");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.expect("body");
    assert_eq!(body["seq"], 4);
    assert!(
        refthing_core::db::items::get(&app.state.pools.read, item_id)
            .await
            .expect("get")
            .is_none(),
        "deleted item is gone"
    );

    // Deleting again 404s.
    let response = app
        .client
        .delete(format!(
            "{}/api/boards/{board_id}/items/{item_id}",
            app.base_url
        ))
        .send()
        .await
        .expect("delete again");
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn batch_of_1k_moves_bumps_seq_once() {
    let app = spawn_app().await;
    let board_id = make_board(&app).await;
    let ids = insert_items(&app, board_id, 1000).await;
    let mut rx = app.state.hub.subscribe(board_id);

    let op_id = Uuid::now_v7();
    let request = BatchRequest {
        atomic: false,
        base_seq: 0,
        client_id: "c1".to_string(),
        ops: vec![BatchOp::Move {
            op_id,
            item_ids: ids.clone(),
            dx: 5.0,
            dy: -3.0,
        }],
    };
    let response = app
        .client
        .post(format!(
            "{}/api/boards/{board_id}/items/batch",
            app.base_url
        ))
        .json(&request)
        .send()
        .await
        .expect("batch");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.expect("body");
    assert_eq!(body["seq"], 1, "one seq bump for 1k moves");
    assert_eq!(body["applied"], json!([op_id]));
    assert_eq!(body["rejected"], json!([]));
    assert_eq!(board_seq(&app, board_id).await, 1);

    // Spot-check that the translate actually landed.
    let (x, y): (f64, f64) = sqlx::query_as("SELECT x, y FROM items WHERE id = ?")
        .bind(ids[0])
        .fetch_one(&app.state.pools.read)
        .await
        .expect("fetch item");
    assert_eq!((x, y), (5.0, -3.0));

    // One event row, ops verbatim.
    let events = events::replay_since(&app.state.pools.read, board_id, 0)
        .await
        .expect("replay");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].origin.as_deref(), Some("c1"));

    // Broadcast diff: applied ops only, origin echoed for suppression.
    let msg = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("diff within timeout")
        .expect("diff received");
    match &*msg {
        ServerMsg::Diff {
            seq,
            origin,
            ops,
            board_id: msg_board,
        } => {
            assert_eq!(*msg_board, board_id);
            assert_eq!(*seq, 1);
            assert_eq!(origin.as_deref(), Some("c1"));
            assert_eq!(ops.len(), 1);
        }
        other => panic!("expected diff, got {other:?}"),
    }
}

#[tokio::test]
#[allow(clippy::too_many_lines, clippy::float_cmp)]
async fn batch_mixed_ops_with_partial_rejection() {
    let app = spawn_app().await;
    let board_id = make_board(&app).await;
    let ids = insert_items(&app, board_id, 3).await;
    let [a, b, c] = ids[..] else {
        panic!("three items");
    };
    let group = refthing_core::db::groups::create(&app.state.pools.write, board_id, None, "g")
        .await
        .expect("create group");

    let op_ids: Vec<Uuid> = (0..4).map(|_| Uuid::now_v7()).collect();
    let request = BatchRequest {
        atomic: false,
        base_seq: 0,
        client_id: "c2".to_string(),
        ops: vec![
            BatchOp::SetZ {
                op_id: op_ids[0],
                order: vec![c, a, b],
            },
            BatchOp::Update {
                op_id: op_ids[1],
                item_id: a,
                fields: ItemPatch {
                    rotation: Some(90.0),
                    metadata: Some(json!({"kind": "image"})),
                    ..ItemPatch::default()
                },
            },
            BatchOp::SetGroup {
                op_id: op_ids[2],
                item_ids: vec![a, b],
                group_id: Some(group.id),
            },
            BatchOp::Update {
                op_id: op_ids[3],
                item_id: Uuid::now_v7(),
                fields: ItemPatch {
                    x: Some(1.0),
                    ..ItemPatch::default()
                },
            },
        ],
    };
    let response = app
        .client
        .post(format!(
            "{}/api/boards/{board_id}/items/batch",
            app.base_url
        ))
        .json(&request)
        .send()
        .await
        .expect("batch");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.expect("body");
    assert_eq!(body["seq"], 1);
    assert_eq!(body["applied"], json!([op_ids[0], op_ids[1], op_ids[2]]));
    assert_eq!(
        body["rejected"],
        json!([{"op_id": op_ids[3], "reason": "item_not_found"}])
    );

    // SetZ assigned z_index by position; update and group landed.
    let ia = refthing_core::db::items::get(&app.state.pools.read, a)
        .await
        .expect("get a")
        .expect("a exists");
    let ib = refthing_core::db::items::get(&app.state.pools.read, b)
        .await
        .expect("get b")
        .expect("b exists");
    let ic = refthing_core::db::items::get(&app.state.pools.read, c)
        .await
        .expect("get c")
        .expect("c exists");
    assert_eq!((ic.z_index, ia.z_index, ib.z_index), (0, 1, 2));
    assert_eq!(ia.rotation, 90.0);
    assert_eq!(ia.group_id, Some(group.id));
    assert_eq!(ib.group_id, Some(group.id));
    assert!(
        refthing_core::db::items::get_metadata(&app.state.pools.read, a)
            .await
            .expect("metadata")
            .is_some(),
        "metadata upserted"
    );

    // An all-rejected batch bumps no seq and writes no event.
    let request = BatchRequest {
        atomic: false,
        base_seq: 1,
        client_id: "c2".to_string(),
        ops: vec![BatchOp::Delete {
            op_id: Uuid::now_v7(),
            item_ids: vec![Uuid::now_v7()],
        }],
    };
    let response = app
        .client
        .post(format!(
            "{}/api/boards/{board_id}/items/batch",
            app.base_url
        ))
        .json(&request)
        .send()
        .await
        .expect("batch");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.expect("body");
    assert_eq!(body["seq"], 1, "no bump when nothing applied");
    assert_eq!(body["applied"], json!([]));
    assert_eq!(body["rejected"].as_array().expect("array").len(), 1);
    assert_eq!(board_seq(&app, board_id).await, 1);
}

#[tokio::test]
async fn batch_with_stale_base_seq_is_409_seq_conflict() {
    let app = spawn_app().await;
    let board_id = make_board(&app).await;
    let ids = insert_items(&app, board_id, 1).await;

    let request = BatchRequest {
        atomic: false,
        base_seq: 42,
        client_id: "c3".to_string(),
        ops: vec![BatchOp::Move {
            op_id: Uuid::now_v7(),
            item_ids: ids,
            dx: 1.0,
            dy: 1.0,
        }],
    };
    let response = app
        .client
        .post(format!(
            "{}/api/boards/{board_id}/items/batch",
            app.base_url
        ))
        .json(&request)
        .send()
        .await
        .expect("batch");
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
    let body: Value = response.json().await.expect("body");
    assert_eq!(body["error"]["code"], "seq_conflict");
    assert_eq!(board_seq(&app, board_id).await, 0, "conflict bumps nothing");
}

#[tokio::test]
async fn ingest_png_streams_to_blob_and_drains_pyramid_job() {
    let app = spawn_app().await;
    let board_id = make_board(&app).await;

    let form = reqwest::multipart::Form::new()
        .part(
            "meta",
            reqwest::multipart::Part::text(json!({"ref.png": {"x": 10.0, "y": 20.0}}).to_string()),
        )
        .part(
            "files",
            reqwest::multipart::Part::bytes(PNG_1X1.to_vec()).file_name("ref.png"),
        );
    let response = app
        .client
        .post(format!(
            "{}/api/boards/{board_id}/items:ingest",
            app.base_url
        ))
        .multipart(form)
        .send()
        .await
        .expect("ingest");
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    let body: Value = response.json().await.expect("body");
    assert_eq!(body["seq"], 1);
    let item = &body["items"][0];
    assert_eq!(item["mime_type"], "image/png");
    assert_eq!(item["poster"], "pending");
    assert_eq!(item["dedup"], false);
    let item_id = Uuid::parse_str(item["item_id"].as_str().expect("id")).expect("uuid");
    let blob_hash = item["blob_hash"].as_str().expect("hash").to_string();

    // The blob file landed at its content-addressed path.
    assert!(
        std::fs::metadata(app.state.blob_store.path(&blob_hash)).is_ok(),
        "blob file exists"
    );

    // The outbox pyramid job carries the payload and drains to done.
    wait_for_done_jobs(&app, 1).await;
    let (payload,): (String,) =
        sqlx::query_as("SELECT payload_json FROM jobs WHERE kind = 'pyramid'")
            .fetch_one(&app.state.pools.read)
            .await
            .expect("job row");
    let payload: Value = serde_json::from_str(&payload).expect("payload json");
    assert_eq!(payload["blob_hash"], json!(blob_hash));
    assert_eq!(payload["mime"], "image/png");
    assert_eq!(payload["item_id"], json!(item_id));

    // The item exists with the meta position.
    let row = refthing_core::db::items::get(&app.state.pools.read, item_id)
        .await
        .expect("get")
        .expect("exists");
    assert_eq!(row.blob_id.as_deref(), Some(blob_hash.as_str()));
    assert_eq!((row.x, row.y), (10.0, 20.0));

    // Re-ingesting the same bytes dedups the blob but creates a second item
    // (auto-cascade position, since no meta matches this filename).
    let form = reqwest::multipart::Form::new().part(
        "files",
        reqwest::multipart::Part::bytes(PNG_1X1.to_vec()).file_name("again.png"),
    );
    let response = app
        .client
        .post(format!(
            "{}/api/boards/{board_id}/items:ingest",
            app.base_url
        ))
        .multipart(form)
        .send()
        .await
        .expect("re-ingest");
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    let body: Value = response.json().await.expect("body");
    assert_eq!(body["seq"], 2);
    assert_eq!(body["items"][0]["dedup"], true);
    assert_eq!(body["items"][0]["blob_hash"], json!(blob_hash));
    wait_for_done_jobs(&app, 2).await;

    // GET snapshot is the boards agent's wave-B endpoint; while it is still a
    // stub the route 404s, so this assertion arms only once it lands.
    let response = app
        .client
        .get(format!("{}/api/boards/{board_id}", app.base_url))
        .send()
        .await
        .expect("snapshot");
    if response.status() == reqwest::StatusCode::OK {
        let snapshot: Value = response.json().await.expect("snapshot body");
        let ids: Vec<&str> = snapshot["items"]
            .as_array()
            .expect("items array")
            .iter()
            .filter_map(|item| item["id"].as_str())
            .collect();
        let expected = item_id.to_string();
        assert!(
            ids.contains(&expected.as_str()),
            "snapshot shows the ingested item"
        );
    }
}
