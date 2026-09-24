//! Integration tests for the Phase 3 derivative pipeline: real pyramid job,
//! derivative serving, snapshot levels, `poster_ready` broadcast, and job
//! recovery.
//!
//! Each test spawns the full router on an ephemeral port against a tempdir
//! SQLite database. PNG fixtures are generated with the `image` crate
//! (dev-only), so every derivative level really gets encoded.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use refthing_core::db::boards;
use refthing_core::db::items::{self, NewItem};
use refthing_core::pipeline::ResizePool;
use refthing_core::storage::BlobStore;
use refthing_core::{AppConfig, db};
use refthing_server::events::BroadcastHub;
use refthing_server::jobs::{JobContext, JobQueue, PyramidJob};
use refthing_server::state::AppState;
use serde_json::{Value, json};
use sqlx::Row;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite;
use uuid::Uuid;

const RECV_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(50);
const POLL_ATTEMPTS: u32 = 200; // 10 s of polling

struct TestApp {
    base_url: String,
    state: AppState,
    client: reqwest::Client,
    _dir: tempfile::TempDir,
}

/// Boots the full router against a tempdir database + blob store. `workers`
/// job workers run the REAL pyramid handler; pass 0 to test queue behavior
/// without anything draining it.
async fn spawn_app(workers: usize) -> TestApp {
    let dir = tempfile::tempdir().expect("temp dir");
    let data_dir = dir.path().to_path_buf();
    let config = AppConfig {
        host: "127.0.0.1".to_string(),
        port: 0,
        data_dir: data_dir.clone(),
        static_dir: None,
    };
    let pools = db::connect(&data_dir.join("refthing.db"))
        .await
        .expect("connect");
    let blob_store = Arc::new(BlobStore::new(data_dir.clone()));
    let jobs = JobQueue::new(pools.write.clone());
    jobs.register("pyramid", PyramidJob);
    let hub = BroadcastHub::new();
    let resize_pool = Arc::new(ResizePool::new());
    if workers > 0 {
        jobs.spawn_workers(
            &JobContext {
                pools: pools.clone(),
                blob_store: blob_store.clone(),
                hub: hub.clone(),
                resize_pool: resize_pool.clone(),
                deriv_root: data_dir.join("deriv"),
            },
            workers,
        );
    }
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
        client: reqwest::Client::new(),
        _dir: dir,
    }
}

/// Encodes a real PNG of the given size (gradient with alpha, so the
/// pipeline exercises the premultiply path).
fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let mut img = image::RgbaImage::new(width, height);
    for (x, y, pixel) in img.enumerate_pixels_mut() {
        *pixel = image::Rgba([(x % 251) as u8, (y % 241) as u8, ((x + y) % 231) as u8, 255]);
    }
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(img)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("encode png");
    bytes
}

async fn make_board(app: &TestApp) -> Uuid {
    boards::create(&app.state.pools.write, "deriv board")
        .await
        .expect("create board")
        .id
}

/// Ingests `bytes` as `name` via the multipart endpoint; returns the parsed
/// 202 body.
async fn ingest(app: &TestApp, board_id: Uuid, name: &str, bytes: Vec<u8>) -> Value {
    let form = reqwest::multipart::Form::new().part(
        "files",
        reqwest::multipart::Part::bytes(bytes).file_name(name.to_string()),
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
        .expect("ingest request");
    assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
    response.json().await.expect("ingest body")
}

/// Waits until all four derivative rows for `hash` are `ready`.
async fn wait_for_derivatives(app: &TestApp, hash: &str) -> Vec<(String, String)> {
    for _ in 0..POLL_ATTEMPTS {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT level, status FROM blob_derivatives WHERE blob_hash = ? ORDER BY level",
        )
        .bind(hash)
        .fetch_all(&app.state.pools.read)
        .await
        .expect("derivative rows");
        if rows.len() == 4 && rows.iter().all(|(_, status)| status == "ready") {
            return rows;
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    panic!("derivatives for {hash} never became ready");
}

/// Waits until the pyramid job for `hash` is `done` (or leaves it failed).
async fn wait_for_job(app: &TestApp, hash: &str) -> String {
    for _ in 0..POLL_ATTEMPTS {
        let row = sqlx::query(
            "SELECT status FROM jobs WHERE kind = 'pyramid' \
             AND json_extract(payload_json, '$.blob_hash') = ? \
             ORDER BY id DESC LIMIT 1",
        )
        .bind(hash)
        .fetch_optional(&app.state.pools.read)
        .await
        .expect("job row");
        if let Some(row) = row {
            let status: String = row.try_get("status").expect("status");
            if status == "done" || status == "failed" {
                return status;
            }
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
    panic!("pyramid job for {hash} never finished");
}

async fn count_pyramid_jobs(app: &TestApp, hash: &str) -> i64 {
    let (count,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM jobs WHERE kind = 'pyramid' \
         AND json_extract(payload_json, '$.blob_hash') = ?",
    )
    .bind(hash)
    .fetch_one(&app.state.pools.read)
    .await
    .expect("count");
    count
}

fn webp_magic(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
}

// ---------------------------------------------------------------------------
// End-to-end: ingest → pyramid → serve
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ingest_generates_derivatives_served_with_caching_headers() {
    let app = spawn_app(1).await;
    let board_id = make_board(&app).await;

    // 1500x900: larger than every level, so thumb/small/medium all generate.
    let png = png_bytes(1500, 900);
    let body = ingest(&app, board_id, "big.png", png).await;
    let hash = body["items"][0]["blob_hash"]
        .as_str()
        .expect("hash")
        .to_string();

    let rows = wait_for_derivatives(&app, &hash).await;
    assert_eq!(
        rows.iter()
            .map(|(level, _)| level.as_str())
            .collect::<Vec<_>>(),
        vec!["full", "medium", "small", "thumb"]
    );

    // The generated WebP levels serve with immutable caching.
    for level in ["thumb", "small", "medium"] {
        let response = reqwest::get(format!("{}/blob/{hash}/{level}", app.base_url))
            .await
            .expect("get derivative");
        assert_eq!(response.status(), reqwest::StatusCode::OK, "level {level}");
        let headers = response.headers();
        assert_eq!(headers[reqwest::header::CONTENT_TYPE], "image/webp");
        assert_eq!(
            headers[reqwest::header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );
        assert_eq!(headers[reqwest::header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(
            headers[reqwest::header::ETAG],
            format!("\"{hash}-{level}\"").as_str()
        );
        let body = response.bytes().await.expect("body");
        assert!(webp_magic(&body), "level {level} is real WebP");
    }

    // Derivative dimensions respect the level caps (longest edge).
    let dims: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT level, width, height FROM blob_derivatives \
         WHERE blob_hash = ? AND status = 'ready'",
    )
    .bind(&hash)
    .fetch_all(&app.state.pools.read)
    .await
    .expect("dims");
    for (level, width, height) in dims {
        let cap = match level.as_str() {
            "thumb" => 64,
            "small" => 256,
            "medium" => 1024,
            "full" => 1500,
            other => panic!("unexpected level {other}"),
        };
        assert!(
            width.max(height) <= cap,
            "level {level}: {width}x{height} exceeds {cap}"
        );
        assert!(width > 0 && height > 0, "level {level} has real dims");
    }
    // The full row records the original pixel dimensions.
    let (full_w, full_h): (i64, i64) = sqlx::query_as(
        "SELECT width, height FROM blob_derivatives WHERE blob_hash = ? AND level = 'full'",
    )
    .bind(&hash)
    .fetch_one(&app.state.pools.read)
    .await
    .expect("full row");
    assert_eq!((full_w, full_h), (1500, 900));
}

#[tokio::test]
async fn derivative_etag_revalidation_returns_304() {
    let app = spawn_app(1).await;
    let board_id = make_board(&app).await;
    let body = ingest(&app, board_id, "big.png", png_bytes(1200, 800)).await;
    let hash = body["items"][0]["blob_hash"]
        .as_str()
        .expect("hash")
        .to_string();
    wait_for_derivatives(&app, &hash).await;

    let etag = format!("\"{hash}-thumb\"");
    let response = app
        .client
        .get(format!("{}/blob/{hash}/thumb", app.base_url))
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

    // A stale ETag must NOT match.
    let response = app
        .client
        .get(format!("{}/blob/{hash}/thumb", app.base_url))
        .header(reqwest::header::IF_NONE_MATCH, "\"stale\"")
        .send()
        .await
        .expect("stale conditional get");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
}

#[tokio::test]
async fn small_image_aliases_missing_levels_to_original_bytes() {
    let app = spawn_app(1).await;
    let board_id = make_board(&app).await;

    // 100x80: only thumb (64) generates; small/medium alias the original.
    let png = png_bytes(100, 80);
    let body = ingest(&app, board_id, "small.png", png.clone()).await;
    let hash = body["items"][0]["blob_hash"]
        .as_str()
        .expect("hash")
        .to_string();
    wait_for_derivatives(&app, &hash).await;

    // thumb is a real WebP derivative.
    let response = reqwest::get(format!("{}/blob/{hash}/thumb", app.base_url))
        .await
        .expect("get thumb");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        response.headers()[reqwest::header::CONTENT_TYPE],
        "image/webp"
    );
    assert!(webp_magic(&response.bytes().await.expect("body")));

    // small/medium/full all serve the ORIGINAL bytes with the original MIME.
    for level in ["small", "medium", "full"] {
        let response = reqwest::get(format!("{}/blob/{hash}/{level}", app.base_url))
            .await
            .expect("get alias level");
        assert_eq!(response.status(), reqwest::StatusCode::OK, "level {level}");
        assert_eq!(
            response.headers()[reqwest::header::CONTENT_TYPE],
            "image/png",
            "level {level}"
        );
        assert_eq!(
            response.headers()[reqwest::header::ETAG],
            format!("\"{hash}-{level}\"").as_str(),
            "level {level}"
        );
        assert_eq!(
            response.bytes().await.expect("body").as_ref(),
            png.as_slice(),
            "level {level} aliases the original bytes"
        );
    }

    // Alias rows carry the original format, thumb carries WebP.
    let formats: Vec<(String, String)> = sqlx::query_as(
        "SELECT level, format FROM blob_derivatives WHERE blob_hash = ? ORDER BY level",
    )
    .bind(&hash)
    .fetch_all(&app.state.pools.read)
    .await
    .expect("formats");
    assert_eq!(
        formats,
        vec![
            ("full".to_string(), "image/png".to_string()),
            ("medium".to_string(), "image/png".to_string()),
            ("small".to_string(), "image/png".to_string()),
            ("thumb".to_string(), "image/webp".to_string()),
        ]
    );
}

#[tokio::test]
async fn snapshot_lists_all_ready_levels() {
    let app = spawn_app(1).await;
    let board_id = make_board(&app).await;
    let body = ingest(&app, board_id, "big.png", png_bytes(1200, 800)).await;
    let hash = body["items"][0]["blob_hash"]
        .as_str()
        .expect("hash")
        .to_string();
    wait_for_derivatives(&app, &hash).await;

    let response = reqwest::get(format!("{}/api/boards/{board_id}", app.base_url))
        .await
        .expect("snapshot");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let snapshot: Value = response.json().await.expect("snapshot body");
    let blob = &snapshot["blobs"][0];
    assert_eq!(blob["hash"], json!(hash));
    let levels = blob["levels"].as_object().expect("levels map");
    for level in ["thumb", "small", "medium", "full"] {
        assert!(
            levels.contains_key(level),
            "levels missing {level}: {levels:?}"
        );
        assert!(levels[level]["width"].as_i64().expect("width") > 0);
        assert!(levels[level]["height"].as_i64().expect("height") > 0);
    }
    assert_eq!(levels["full"]["width"], 1200);
    assert_eq!(levels["full"]["height"], 800);
}

// ---------------------------------------------------------------------------
// WS broadcast
// ---------------------------------------------------------------------------

#[tokio::test]
async fn poster_ready_is_broadcast_over_ws() {
    let app = spawn_app(1).await;
    let board_id = make_board(&app).await;

    // Connect BEFORE ingest so the broadcast lands in our receiver.
    let ws_url = format!(
        "{}/api/boards/{board_id}/ws?client_id={}",
        app.base_url.replacen("http", "ws", 1),
        Uuid::now_v7()
    );
    let (mut socket, response) = tokio_tungstenite::connect_async(ws_url)
        .await
        .expect("ws connect");
    assert_eq!(
        response.status(),
        tungstenite::http::StatusCode::SWITCHING_PROTOCOLS
    );

    let body = ingest(&app, board_id, "big.png", png_bytes(1200, 800)).await;
    let hash = body["items"][0]["blob_hash"]
        .as_str()
        .expect("hash")
        .to_string();
    let item_id = body["items"][0]["item_id"].as_str().expect("item_id");

    // Frames arrive as hello, then the ingest diff, then poster_ready —
    // read until the job message shows up.
    let poster = async {
        loop {
            let frame = socket
                .next()
                .await
                .expect("ws stream ended")
                .expect("ws frame");
            let text = frame.into_text().expect("text frame");
            let json: Value = serde_json::from_str(text.as_str()).expect("json frame");
            if json["type"] == "job" {
                return json;
            }
        }
    };
    let poster = tokio::time::timeout(RECV_TIMEOUT, poster)
        .await
        .expect("poster_ready timed out");
    assert_eq!(poster["kind"], "poster_ready");
    assert_eq!(poster["payload"]["blob_hash"], json!(hash));
    assert_eq!(poster["payload"]["item_id"], json!(item_id));
    let levels: Vec<&str> = poster["payload"]["levels"]
        .as_array()
        .expect("levels array")
        .iter()
        .map(|level| level.as_str().expect("level name"))
        .collect();
    for level in ["thumb", "small", "medium", "full"] {
        assert!(levels.contains(&level), "levels missing {level}");
    }
}

// ---------------------------------------------------------------------------
// Pending / failed / non-image paths
// ---------------------------------------------------------------------------

/// Seeds a blob + item WITHOUT going through ingest, so no pyramid job is
/// enqueued by the mutation path.
async fn seed_blob_with_item(app: &TestApp, board_id: Uuid, png: &[u8]) -> String {
    let blob = app.state.blob_store.put(png).await.expect("put blob");
    refthing_core::db::blobs::insert_or_ignore(
        &app.state.pools.write,
        &blob.hash,
        Some("seeded.png"),
        &blob.mime,
        i64::try_from(blob.byte_size).expect("size fits"),
        None,
        None,
    )
    .await
    .expect("register blob");
    items::create(
        &app.state.pools.write,
        NewItem {
            board_id,
            item_type: "image".to_string(),
            blob_id: Some(blob.hash.clone()),
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
    .expect("create item");
    blob.hash
}

#[tokio::test]
async fn pending_derivative_404_triggers_single_flight_reenqueue() {
    // No workers: enqueued jobs stay put so we can observe the dedupe.
    let app = spawn_app(0).await;
    let board_id = make_board(&app).await;
    let hash = seed_blob_with_item(&app, board_id, &png_bytes(300, 200)).await;

    for attempt in 0..2 {
        let response = reqwest::get(format!("{}/blob/{hash}/thumb", app.base_url))
            .await
            .expect("get pending derivative");
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
        assert_eq!(response.headers()["x-derivative"], "pending");
        assert_eq!(
            count_pyramid_jobs(&app, &hash).await,
            1,
            "attempt {attempt}: single-flight dedupe"
        );
    }

    // The enqueued job is genuinely runnable (payload shape matches ingest).
    let row = sqlx::query("SELECT payload_json FROM jobs WHERE kind = 'pyramid'")
        .fetch_one(&app.state.pools.read)
        .await
        .expect("job row");
    let payload: Value =
        serde_json::from_str(row.try_get("payload_json").expect("payload")).expect("payload json");
    assert_eq!(payload["blob_hash"], json!(hash));
    assert_eq!(payload["mime"], "image/png");
    assert!(payload["item_id"].is_string());
}

#[tokio::test]
async fn failed_derivative_is_404_failed() {
    let app = spawn_app(0).await;
    let board_id = make_board(&app).await;
    let hash = seed_blob_with_item(&app, board_id, &png_bytes(300, 200)).await;
    sqlx::query(
        "INSERT INTO blob_derivatives \
             (blob_hash, level, width, height, byte_size, format, status) \
         VALUES (?, 'thumb', 0, 0, 0, '', 'failed')",
    )
    .bind(&hash)
    .execute(&app.state.pools.write)
    .await
    .expect("seed failed row");

    let response = reqwest::get(format!("{}/blob/{hash}/thumb", app.base_url))
        .await
        .expect("get failed derivative");
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    assert_eq!(response.headers()["x-derivative"], "failed");

    // A failed row does NOT trigger a re-enqueue.
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM jobs")
        .fetch_one(&app.state.pools.read)
        .await
        .expect("count");
    assert_eq!(count, 0);
}

#[tokio::test]
async fn non_image_ingest_drains_without_derivatives() {
    let app = spawn_app(1).await;
    let board_id = make_board(&app).await;

    let body = ingest(
        &app,
        board_id,
        "notes.bin",
        b"\x00\x01\x02\x03binary".to_vec(),
    )
    .await;
    let hash = body["items"][0]["blob_hash"]
        .as_str()
        .expect("hash")
        .to_string();
    assert_eq!(body["items"][0]["mime_type"], "application/octet-stream");

    assert_eq!(wait_for_job(&app, &hash).await, "done");
    let (count,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM blob_derivatives WHERE blob_hash = ?")
            .bind(&hash)
            .fetch_one(&app.state.pools.read)
            .await
            .expect("count");
    assert_eq!(count, 0, "non-image blobs get no derivative rows");

    // full still serves the original bytes.
    let response = reqwest::get(format!("{}/blob/{hash}/full", app.base_url))
        .await
        .expect("get full");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
}

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

#[tokio::test]
async fn running_pyramid_job_is_reclaimed_and_completed() {
    let app = spawn_app(0).await;
    let board_id = make_board(&app).await;
    let hash = seed_blob_with_item(&app, board_id, &png_bytes(1200, 800)).await;

    // Enqueue a pyramid job, then simulate a crash mid-run.
    let item_id: (Uuid,) = sqlx::query_as("SELECT id FROM items WHERE blob_id = ? LIMIT 1")
        .bind(&hash)
        .fetch_one(&app.state.pools.read)
        .await
        .expect("item");
    let payload = json!({
        "blob_hash": hash,
        "mime": "image/png",
        "item_id": item_id.0,
    });
    let job_id = app
        .state
        .jobs
        .enqueue("pyramid", payload)
        .await
        .expect("enqueue");
    sqlx::query("UPDATE jobs SET status = 'running' WHERE id = ?")
        .bind(job_id)
        .execute(&app.state.pools.write)
        .await
        .expect("simulate crash");

    // Startup recovery releases it, then a worker run completes it.
    let recovered = app.state.jobs.recover_running().await.expect("recover");
    assert_eq!(recovered, 1);
    let ctx = JobContext {
        pools: app.state.pools.clone(),
        blob_store: app.state.blob_store.clone(),
        hub: app.state.hub.clone(),
        resize_pool: app.state.resize_pool.clone(),
        deriv_root: app.state.config.data_dir.join("deriv"),
    };
    assert!(
        app.state
            .jobs
            .execute_next(&ctx)
            .await
            .expect("run recovered job")
    );
    let (status,): (String,) = sqlx::query_as("SELECT status FROM jobs WHERE id = ?")
        .bind(job_id)
        .fetch_one(&app.state.pools.read)
        .await
        .expect("job row");
    assert_eq!(status, "done");

    // Derivatives were really generated.
    let rows = wait_for_derivatives(&app, &hash).await;
    assert_eq!(rows.len(), 4);
    let response = reqwest::get(format!("{}/blob/{hash}/medium", app.base_url))
        .await
        .expect("get medium");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        response.headers()[reqwest::header::CONTENT_TYPE],
        "image/webp"
    );
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

#[tokio::test]
async fn health_reports_job_counts() {
    let app = spawn_app(0).await;
    let board_id = make_board(&app).await;
    let hash = seed_blob_with_item(&app, board_id, &png_bytes(100, 100)).await;

    // One pending pyramid job (via the re-enqueue backstop), one failed job.
    let response = reqwest::get(format!("{}/blob/{hash}/thumb", app.base_url))
        .await
        .expect("get pending derivative");
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    sqlx::query("INSERT INTO jobs (kind, payload_json, status) VALUES ('pyramid', '{}', 'failed')")
        .execute(&app.state.pools.write)
        .await
        .expect("seed failed job");

    let response = reqwest::get(format!("{}/api/health", app.base_url))
        .await
        .expect("health");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: Value = response.json().await.expect("health body");
    assert_eq!(body["status"], "ok");
    assert_eq!(body["pending_jobs"], 1);
    assert_eq!(body["failed_jobs"], 1);
}
