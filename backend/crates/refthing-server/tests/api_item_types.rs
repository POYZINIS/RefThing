//! Phase 11 item types through the real ingest endpoint: images placed at
//! their true proportions, generic files as cards with no poster job, and
//! (when ffmpeg is installed) video/audio probed and given posters.

use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration;

use refthing_core::AppConfig;
use refthing_core::db::{self, boards};
use refthing_core::pipeline::ResizePool;
use refthing_core::storage::BlobStore;
use refthing_server::events::BroadcastHub;
use refthing_server::jobs::media_poster::MediaPosterJob;
use refthing_server::jobs::{JobContext, JobQueue, PyramidJob};
use refthing_server::state::AppState;
use serde_json::Value;
use uuid::Uuid;

struct TestApp {
    base: String,
    state: AppState,
    dir: tempfile::TempDir,
}

async fn spawn_app() -> TestApp {
    let dir = tempfile::tempdir().expect("temp dir");
    let data_dir = dir.path().to_path_buf();
    let pools = db::connect(&data_dir.join("refthing.db"))
        .await
        .expect("connect");
    let blob_store = Arc::new(BlobStore::new(data_dir.clone()));
    let jobs = JobQueue::new(pools.write.clone());
    jobs.register("pyramid", PyramidJob);
    jobs.register("media_poster", MediaPosterJob);
    let hub = BroadcastHub::new();
    let resize_pool = Arc::new(ResizePool::new());
    jobs.spawn_workers(
        &JobContext {
            pools: pools.clone(),
            blob_store: blob_store.clone(),
            hub: hub.clone(),
            resize_pool: resize_pool.clone(),
            deriv_root: data_dir.join("deriv"),
        },
        2,
    );
    let state = AppState {
        config: Arc::new(AppConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            data_dir,
            static_dir: None,
        }),
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
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move { axum::serve(listener, app).await.expect("serve") });
    TestApp {
        base: format!("http://{addr}"),
        state,
        dir,
    }
}

async fn ingest(app: &TestApp, board: Uuid, name: &str, bytes: Vec<u8>) -> Value {
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(bytes).file_name(name.to_string()),
    );
    let response = reqwest::Client::new()
        .post(format!("{}/api/boards/{board}/items:ingest", app.base))
        .multipart(form)
        .send()
        .await
        .expect("ingest");
    assert_eq!(response.status(), 202);
    response.json::<Value>().await.expect("json")["items"][0].clone()
}

async fn item(app: &TestApp, board: Uuid, id: &str) -> Value {
    let snapshot: Value = reqwest::get(format!("{}/api/boards/{board}", app.base))
        .await
        .expect("snapshot")
        .json()
        .await
        .expect("json");
    snapshot["items"]
        .as_array()
        .expect("items")
        .iter()
        .find(|item| item["id"] == id)
        .expect("item")
        .clone()
}

async fn jobs_settled(app: &TestApp) {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let (open,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM jobs WHERE status NOT IN ('done', 'failed')")
                .fetch_one(&app.state.pools.read)
                .await
                .expect("count");
        if open == 0 {
            return;
        }
        assert!(std::time::Instant::now() < deadline, "jobs did not settle");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let image =
        image::RgbImage::from_fn(width, height, |x, _| image::Rgb([(x % 255) as u8, 90, 160]));
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .expect("encode");
    bytes.into_inner()
}

#[tokio::test]
async fn images_are_placed_at_their_true_proportions() {
    let app = spawn_app().await;
    let board = boards::create(&app.state.pools.write, "b")
        .await
        .expect("board")
        .id;
    let wide = ingest(&app, board, "wide.png", png(400, 100)).await;
    assert_eq!(
        (wide["width"].as_f64(), wide["height"].as_f64()),
        (Some(400.0), Some(100.0))
    );
    let huge = ingest(&app, board, "huge.png", png(3200, 1600)).await;
    assert_eq!(
        (huge["width"].as_f64(), huge["height"].as_f64()),
        (Some(1600.0), Some(800.0)),
        "long edge capped, proportions kept"
    );
    let stored = item(&app, board, wide["item_id"].as_str().expect("id")).await;
    assert_eq!(stored["type"], "image");
    assert_eq!(
        (stored["width"].as_f64(), stored["height"].as_f64()),
        (Some(400.0), Some(100.0))
    );
}

#[tokio::test]
async fn unknown_files_become_cards_with_no_poster_job() {
    let app = spawn_app().await;
    let board = boards::create(&app.state.pools.write, "b")
        .await
        .expect("board")
        .id;
    let file = ingest(
        &app,
        board,
        "notes.bin",
        b"just some bytes, not media".to_vec(),
    )
    .await;
    let stored = item(&app, board, file["item_id"].as_str().expect("id")).await;
    assert_eq!(stored["type"], "file");
    assert_eq!(
        (stored["width"].as_f64(), stored["height"].as_f64()),
        (Some(200.0), Some(240.0))
    );
    let (jobs,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM jobs")
        .fetch_one(&app.state.pools.read)
        .await
        .expect("count");
    assert_eq!(jobs, 0, "a generic file needs no poster job");
}

fn ffmpeg_available() -> bool {
    std::process::Command::new(refthing_server::item_types::tool("ffmpeg"))
        .arg("-version")
        .output()
        .is_ok_and(|output| output.status.success())
}

fn ffmpeg(dir: &std::path::Path, args: &[&str], name: &str) -> Vec<u8> {
    let out = dir.join(name);
    let status = std::process::Command::new(refthing_server::item_types::tool("ffmpeg"))
        .args(["-v", "error", "-y"])
        .args(args)
        .arg(&out)
        .status()
        .expect("run ffmpeg");
    assert!(status.success(), "ffmpeg failed to make {name}");
    std::fs::read(out).expect("read media")
}

#[tokio::test]
async fn media_items_are_probed_and_get_posters() {
    if !ffmpeg_available() {
        eprintln!("ffmpeg not installed: skipping media poster test");
        return;
    }
    let app = spawn_app().await;
    let board = boards::create(&app.state.pools.write, "b")
        .await
        .expect("board")
        .id;
    let scratch = app.dir.path().join("fixtures");
    std::fs::create_dir_all(&scratch).expect("fixtures dir");
    let video_bytes = ffmpeg(
        &scratch,
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=2:size=320x240:rate=10",
            "-pix_fmt",
            "yuv420p",
        ],
        "clip.mp4",
    );
    let audio_bytes = ffmpeg(
        &scratch,
        &["-f", "lavfi", "-i", "sine=frequency=440:duration=1"],
        "tone.wav",
    );

    let video = ingest(&app, board, "clip.mp4", video_bytes).await;
    let audio = ingest(&app, board, "tone.wav", audio_bytes).await;
    jobs_settled(&app).await;

    let stored = item(&app, board, video["item_id"].as_str().expect("id")).await;
    assert_eq!(stored["type"], "video");
    assert_eq!(
        (stored["width"].as_f64(), stored["height"].as_f64()),
        (Some(320.0), Some(240.0))
    );
    let duration = stored["metadata"]["duration"].as_f64().expect("duration");
    assert!((duration - 2.0).abs() < 0.2, "duration {duration}");

    let stored = item(&app, board, audio["item_id"].as_str().expect("id")).await;
    assert_eq!(stored["type"], "audio");
    assert_eq!(
        (stored["width"].as_f64(), stored["height"].as_f64()),
        (Some(480.0), Some(120.0))
    );

    // Both blobs got a poster pyramid the canvas can draw.
    for hash in [&video["blob_hash"], &audio["blob_hash"]] {
        let hash = hash.as_str().expect("hash");
        let response = reqwest::get(format!("{}/blob/{hash}/small", app.base))
            .await
            .expect("get");
        assert_eq!(response.status(), 200, "poster derivative for {hash}");
        let bytes = response.bytes().await.expect("bytes");
        assert!(
            image::load_from_memory(&bytes).is_ok(),
            "poster decodes as an image"
        );
    }
}
