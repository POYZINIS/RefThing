//! Integration tests for the WebSocket endpoint (`GET /api/boards/{id}/ws`)
//! and blob serving (`GET /blob/{hash}/{level}`).
//!
//! Each test spawns the full router on an ephemeral port against a tempdir
//! SQLite database; WS clients are tokio-tungstenite, REST calls are reqwest.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use refthing_core::db::blobs;
use refthing_core::db::boards;
use refthing_core::db::items::{self, NewItem};
use refthing_core::pipeline::ResizePool;
use refthing_core::storage::BlobStore;
use refthing_core::{AppConfig, db};
use refthing_server::events::BroadcastHub;
use refthing_server::events::hub::ServerMsg;
use refthing_server::jobs::{JobContext, JobQueue, PyramidJob};
use refthing_server::state::AppState;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite;
use uuid::Uuid;

/// Minimal valid 1x1 PNG (sniffed as `image/png`).
const PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
];

const RECV_TIMEOUT: Duration = Duration::from_secs(10);

struct TestApp {
    base_url: String,
    state: AppState,
    _dir: tempfile::TempDir,
}

impl TestApp {
    fn ws_url(&self, board_id: Uuid, client_id: Uuid) -> String {
        format!(
            "{}/api/boards/{board_id}/ws?client_id={client_id}",
            self.base_url.replacen("http", "ws", 1)
        )
    }
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
    jobs.spawn_workers(
        &JobContext {
            pools: pools.clone(),
            blob_store: blob_store.clone(),
            hub: hub.clone(),
            resize_pool: resize_pool.clone(),
            deriv_root: dir.path().join("deriv"),
        },
        1,
    );
    let state = AppState {
        config: Arc::new(config),
        auth_token: Arc::from("test-token"),
        pools,
        blob_store,
        jobs,
        hub,
        resize_pool,
    };

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local addr");
    let server_state = state.clone();
    tokio::spawn(async move {
        axum::serve(
            listener,
            refthing_server::router::build_router(server_state),
        )
        .await
        .expect("serve");
    });

    TestApp {
        base_url: format!("http://{addr}"),
        state,
        _dir: dir,
    }
}

async fn create_board(app: &TestApp, name: &str) -> Uuid {
    boards::create(&app.state.pools.write, name)
        .await
        .expect("create board")
        .id
}

/// Creates an item WITHOUT bumping the board seq (direct core CRUD), so tests
/// control seq precisely.
async fn create_item(app: &TestApp, board_id: Uuid) -> Uuid {
    items::create(
        &app.state.pools.write,
        NewItem {
            board_id,
            item_type: "image".to_string(),
            blob_id: None,
            x: 0.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
            rotation: 0.0,
            z_index: 0,
            group_id: None,
        },
    )
    .await
    .expect("create item")
    .id
}

type WsClient =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn ws_connect(app: &TestApp, board_id: Uuid, client_id: Uuid) -> WsClient {
    let (socket, response) = tokio_tungstenite::connect_async(app.ws_url(board_id, client_id))
        .await
        .expect("ws connect");
    assert_eq!(
        response.status(),
        tungstenite::http::StatusCode::SWITCHING_PROTOCOLS
    );
    socket
}

/// Reads the next text frame, skipping any protocol-level noise.
async fn recv_frame(socket: &mut WsClient) -> Value {
    let frame = tokio::time::timeout(RECV_TIMEOUT, socket.next())
        .await
        .expect("ws frame timed out")
        .expect("ws stream ended")
        .expect("ws frame error");
    let text = frame.into_text().expect("text frame");
    serde_json::from_str(text.as_str()).expect("json frame")
}

async fn recv_server_msg(socket: &mut WsClient) -> ServerMsg {
    let json = recv_frame(socket).await;
    serde_json::from_value(json).expect("ServerMsg")
}

async fn recv_hello(socket: &mut WsClient) -> ServerMsg {
    match recv_server_msg(socket).await {
        hello @ ServerMsg::Hello { .. } => hello,
        other => panic!("expected hello, got {other:?}"),
    }
}

fn move_batch(base_seq: i64, client_id: &str, item_id: Uuid) -> Value {
    json!({
        "base_seq": base_seq,
        "client_id": client_id,
        "ops": [{
            "kind": "move",
            "op_id": Uuid::now_v7(),
            "item_ids": [item_id],
            "dx": 5.0,
            "dy": -3.0,
        }],
    })
}

// ---------------------------------------------------------------------------
// WebSocket tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn hello_carries_board_and_current_seq() {
    let app = spawn_app().await;
    let board_id = create_board(&app, "ws board").await;

    let mut socket = ws_connect(&app, board_id, Uuid::now_v7()).await;
    match recv_hello(&mut socket).await {
        ServerMsg::Hello {
            board_id: hello_board,
            seq,
            server_time,
        } => {
            assert_eq!(hello_board, board_id);
            assert_eq!(seq, 0);
            assert!(server_time > 0);
        }
        other => panic!("expected hello, got {other:?}"),
    }
}

#[tokio::test]
async fn hello_seq_reflects_committed_batches() {
    let app = spawn_app().await;
    let board_id = create_board(&app, "ws board").await;
    let item_id = create_item(&app, board_id).await;

    // Commit one batch over WS, then reconnect: the new hello must show seq 1.
    let mut first = ws_connect(&app, board_id, Uuid::now_v7()).await;
    recv_hello(&mut first).await;
    first
        .send(tungstenite::Message::text(
            move_batch(0, "first-client", item_id).to_string(),
        ))
        .await
        .expect("send batch");
    // The batch machinery broadcasts the diff back to the room (echo
    // suppression is client-side), so the sender sees its own diff.
    match recv_server_msg(&mut first).await {
        ServerMsg::Diff { seq, .. } => assert_eq!(seq, 1),
        other => panic!("expected diff, got {other:?}"),
    }
    drop(first);

    let mut second = ws_connect(&app, board_id, Uuid::now_v7()).await;
    match recv_hello(&mut second).await {
        ServerMsg::Hello { seq, .. } => assert_eq!(seq, 1),
        other => panic!("expected hello, got {other:?}"),
    }
}

#[tokio::test]
async fn rest_batch_reaches_all_ws_clients_in_room() {
    let app = spawn_app().await;
    let board_id = create_board(&app, "ws board").await;
    let item_id = create_item(&app, board_id).await;

    let mut client_a = ws_connect(&app, board_id, Uuid::now_v7()).await;
    let mut client_b = ws_connect(&app, board_id, Uuid::now_v7()).await;
    recv_hello(&mut client_a).await;
    recv_hello(&mut client_b).await;

    let response = reqwest::Client::new()
        .post(format!(
            "{}/api/boards/{board_id}/items/batch",
            app.base_url
        ))
        .json(&move_batch(0, "rest-client", item_id))
        .send()
        .await
        .expect("batch request");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.expect("batch response json");
    let seq = body["seq"].as_i64().expect("seq in batch response");
    assert_eq!(seq, 1);

    for (name, socket) in [("a", &mut client_a), ("b", &mut client_b)] {
        match recv_server_msg(socket).await {
            ServerMsg::Diff {
                board_id: diff_board,
                seq,
                origin,
                ops,
            } => {
                assert_eq!(diff_board, board_id, "client {name}");
                assert_eq!(seq, 1, "client {name}");
                assert_eq!(origin.as_deref(), Some("rest-client"), "client {name}");
                assert_eq!(ops.len(), 1, "client {name}");
            }
            other => panic!("client {name}: expected diff, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn ws_batch_is_applied_and_broadcast_to_the_room() {
    let app = spawn_app().await;
    let board_id = create_board(&app, "ws board").await;
    let item_id = create_item(&app, board_id).await;

    let mut sender = ws_connect(&app, board_id, Uuid::now_v7()).await;
    let mut watcher = ws_connect(&app, board_id, Uuid::now_v7()).await;
    recv_hello(&mut sender).await;
    recv_hello(&mut watcher).await;

    sender
        .send(tungstenite::Message::text(
            move_batch(0, "ws-sender", item_id).to_string(),
        ))
        .await
        .expect("send batch");

    // Both the watcher and the sender itself receive the committed diff.
    for (name, socket) in [("watcher", &mut watcher), ("sender", &mut sender)] {
        match recv_server_msg(socket).await {
            ServerMsg::Diff {
                seq, origin, ops, ..
            } => {
                assert_eq!(seq, 1, "client {name}");
                assert_eq!(origin.as_deref(), Some("ws-sender"), "client {name}");
                assert_eq!(ops.len(), 1, "client {name}");
            }
            other => panic!("client {name}: expected diff, got {other:?}"),
        }
    }

    // The mutation really landed.
    let item = items::get(&app.state.pools.read, item_id)
        .await
        .expect("get item")
        .expect("item exists");
    assert_eq!((item.x, item.y), (5.0, -3.0));
}

#[tokio::test]
async fn malformed_frame_gets_error_frame_back() {
    let app = spawn_app().await;
    let board_id = create_board(&app, "ws board").await;

    let mut socket = ws_connect(&app, board_id, Uuid::now_v7()).await;
    recv_hello(&mut socket).await;
    socket
        .send(tungstenite::Message::text("this is not json"))
        .await
        .expect("send garbage");

    let frame = recv_frame(&mut socket).await;
    assert_eq!(frame["type"], "error");
    assert_eq!(frame["code"], "bad_request");
    assert!(frame["message"].is_string());
}

#[tokio::test]
async fn stale_base_seq_gets_conflict_error_frame() {
    let app = spawn_app().await;
    let board_id = create_board(&app, "ws board").await;
    let item_id = create_item(&app, board_id).await;

    let mut socket = ws_connect(&app, board_id, Uuid::now_v7()).await;
    recv_hello(&mut socket).await;
    socket
        .send(tungstenite::Message::text(
            move_batch(99, "stale-client", item_id).to_string(),
        ))
        .await
        .expect("send stale batch");

    let frame = recv_frame(&mut socket).await;
    assert_eq!(frame["type"], "error");
    assert_eq!(frame["code"], "seq_conflict");
}

#[tokio::test]
async fn unknown_board_is_rejected_before_upgrade() {
    let app = spawn_app().await;
    let result = tokio_tungstenite::connect_async(app.ws_url(Uuid::now_v7(), Uuid::now_v7())).await;
    let Err(tungstenite::Error::Http(response)) = result else {
        panic!("expected http error, got {result:?}");
    };
    assert_eq!(response.status(), tungstenite::http::StatusCode::NOT_FOUND);
}

// ---------------------------------------------------------------------------
// Blob tests
// ---------------------------------------------------------------------------

/// Puts bytes into the store and registers the blob row; returns the hash.
async fn seed_blob(app: &TestApp, bytes: &[u8]) -> String {
    let blob = app.state.blob_store.put(bytes).await.expect("put blob");
    blobs::insert_or_ignore(
        &app.state.pools.write,
        &blob.hash,
        Some("pixel.png"),
        &blob.mime,
        i64::try_from(blob.byte_size).expect("size fits"),
        None,
        None,
    )
    .await
    .expect("register blob");
    blob.hash
}

#[tokio::test]
async fn full_blob_round_trips_with_immutable_caching_headers() {
    let app = spawn_app().await;
    let hash = seed_blob(&app, PNG_1X1).await;

    let response = reqwest::get(format!("{}/blob/{hash}/full", app.base_url))
        .await
        .expect("get blob");
    assert_eq!(response.status(), reqwest::StatusCode::OK);

    let headers = response.headers();
    assert_eq!(
        headers[reqwest::header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(
        headers[reqwest::header::ETAG],
        format!("\"{hash}-full\"").as_str()
    );
    assert_eq!(headers[reqwest::header::CONTENT_TYPE], "image/png");
    assert_eq!(headers[reqwest::header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(
        headers[reqwest::header::CONTENT_LENGTH],
        PNG_1X1.len().to_string().as_str()
    );

    let body = response.bytes().await.expect("body bytes");
    assert_eq!(body.as_ref(), PNG_1X1);
}

#[tokio::test]
async fn if_none_match_returns_304() {
    let app = spawn_app().await;
    let hash = seed_blob(&app, PNG_1X1).await;
    let etag = format!("\"{hash}-full\"");

    let response = reqwest::Client::new()
        .get(format!("{}/blob/{hash}/full", app.base_url))
        .header(reqwest::header::IF_NONE_MATCH, &etag)
        .send()
        .await
        .expect("conditional get");
    assert_eq!(response.status(), reqwest::StatusCode::NOT_MODIFIED);
    assert_eq!(response.headers()[reqwest::header::ETAG], etag.as_str());
    assert_eq!(
        response.headers()[reqwest::header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert!(response.bytes().await.expect("body").is_empty());

    // A stale ETag must NOT match.
    let response = reqwest::Client::new()
        .get(format!("{}/blob/{hash}/full", app.base_url))
        .header(reqwest::header::IF_NONE_MATCH, "\"stale-etag\"")
        .send()
        .await
        .expect("stale conditional get");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
}

#[tokio::test]
async fn derivative_levels_are_404_pending() {
    let app = spawn_app().await;
    let hash = seed_blob(&app, PNG_1X1).await;

    for level in ["thumb", "small", "medium"] {
        let response = reqwest::get(format!("{}/blob/{hash}/{level}", app.base_url))
            .await
            .expect("get derivative");
        assert_eq!(
            response.status(),
            reqwest::StatusCode::NOT_FOUND,
            "level {level}"
        );
        assert_eq!(
            response.headers()["x-derivative"],
            "pending",
            "level {level}"
        );
    }
}

#[tokio::test]
async fn unknown_hash_and_unknown_level_are_404() {
    let app = spawn_app().await;
    let missing = "0".repeat(64);

    for level in ["full", "thumb"] {
        let response = reqwest::get(format!("{}/blob/{missing}/{level}", app.base_url))
            .await
            .expect("get missing blob");
        assert_eq!(
            response.status(),
            reqwest::StatusCode::NOT_FOUND,
            "level {level}"
        );
        assert!(
            !response.headers().contains_key("x-derivative"),
            "unknown hash is not a pending derivative (level {level})"
        );
    }

    let hash = seed_blob(&app, PNG_1X1).await;
    let response = reqwest::get(format!("{}/blob/{hash}/huge", app.base_url))
        .await
        .expect("get unknown level");
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    assert!(!response.headers().contains_key("x-derivative"));
}
