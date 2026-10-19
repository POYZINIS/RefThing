//! `POST /api/boards:import`: a `PureRef` 2 board file becomes a new board.
//!
//! The fixture is built here, not checked in: a `SQLite` database with
//! `PureRef`'s tables, Qt values written into TEXT columns one `Latin-1` char per
//! byte (as `PureRef` 2.1 does), displaced into a `.pur` container exactly as
//! `refthing_core::pureref` documents.

use std::sync::Arc;

use refthing_core::pipeline::ResizePool;
use refthing_core::storage::BlobStore;
use refthing_core::{AppConfig, db};
use refthing_server::events;
use refthing_server::jobs::{JobContext, JobQueue, PyramidJob};
use refthing_server::state::AppState;
use serde_json::Value;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

/// 2x1 PNG (red, blue): wide, so width and height can't be confused.
fn png_2x1() -> Vec<u8> {
    let mut image = image::RgbImage::new(2, 1);
    image.put_pixel(0, 0, image::Rgb([255, 0, 0]));
    image.put_pixel(1, 0, image::Rgb([0, 0, 255]));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .expect("encode png");
    bytes.into_inner()
}

struct TestApp {
    base_url: String,
    client: reqwest::Client,
    dir: tempfile::TempDir,
}

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
    job_queue.spawn_workers(
        &JobContext {
            pools: pools.clone(),
            blob_store: blob_store.clone(),
            hub: hub.clone(),
            resize_pool: resize_pool.clone(),
            deriv_root: data_dir.join("deriv"),
        },
        1,
    );
    let state = AppState {
        config: Arc::new(config),
        auth_token: Arc::from("test-token"),
        pools,
        blob_store,
        jobs: job_queue,
        hub,
        resize_pool,
    };
    let app = refthing_server::router::build_router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("local addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });
    TestApp {
        base_url: format!("http://{addr}"),
        client: reqwest::Client::new(),
        dir,
    }
}

// ------------------------------------------------------------- fixture --

fn qstring(text: &str) -> Vec<u8> {
    let units: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
    let mut out = u32::try_from(units.len())
        .expect("short")
        .to_be_bytes()
        .to_vec();
    out.extend(units);
    out
}

/// A Qt stream as `PureRef` stores it in a TEXT column.
fn as_text(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

fn transform(m11: f64, m12: f64, m21: f64, m22: f64, dx: f64, dy: f64) -> String {
    let mut out = 80_u32.to_be_bytes().to_vec();
    out.push(0);
    for value in [m11, m12, 0.0, m21, m22, 0.0, dx, dy, 1.0] {
        out.extend(value.to_be_bytes());
    }
    as_text(&out)
}

fn size(width: f64, height: f64) -> String {
    let mut out = 22_u32.to_be_bytes().to_vec();
    out.push(0);
    out.extend(width.to_be_bytes());
    out.extend(height.to_be_bytes());
    as_text(&out)
}

/// A `PureRef`-shaped board: one 2x1 image scaled 100x (200x100 on screen),
/// centred at (500, 300), mirrored; the same image again at 50x; and a note
/// labelling the first, parented to it.
async fn build_pur(dir: &std::path::Path) -> Vec<u8> {
    let path = dir.join("fixture.sqlite");
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::new()
                .filename(&path)
                .create_if_missing(true),
        )
        .await
        .expect("fixture db");
    for statement in [
        "CREATE TABLE images (id INTEGER PRIMARY KEY, source_type INTEGER, origin TEXT, source TEXT, \
         format TEXT, checksum TEXT, data BLOB, width INTEGER, height INTEGER)",
        "CREATE TABLE items (parent INTEGER, id INTEGER PRIMARY KEY, name TEXT, transform BLOB, \
         sort_order BLOB, z REAL, opacity REAL, locked INTEGER, comment INTEGER)",
        "CREATE TABLE items_images (image INTEGER, playback_speed REAL, id INTEGER PRIMARY KEY, \
         playback_state INTEGER, image_transform BLOB, image_bounds BLOB, playback_frame INTEGER, \
         flags INTEGER)",
        "CREATE TABLE items_notes (text_color TEXT, id INTEGER PRIMARY KEY, fixed_size TEXT, \
         background_color TEXT, text TEXT, style INTEGER)",
        "CREATE TABLE items_drawings (id INTEGER PRIMARY KEY, strokes BLOB)",
    ] {
        sqlx::query(statement).execute(&pool).await.expect("schema");
    }
    sqlx::query("INSERT INTO images VALUES (7, 1, 'C:/refs/stripes.png', 'C:/refs/stripes.png', 'PNG', '', ?, 2, 1)")
        .bind(png_2x1())
        .execute(&pool)
        .await
        .expect("image");
    let centred = transform(1.0, 0.0, 0.0, 1.0, -1.0, -0.5);
    for (id, parent, item, z, opacity) in [
        (
            1_i64,
            -1_i64,
            transform(-100.0, 0.0, 0.0, 100.0, 500.0, 300.0),
            2.0,
            1.0,
        ),
        (2, -1, transform(50.0, 0.0, 0.0, 50.0, 0.0, 0.0), 1.0, 0.5),
        // The note is the first image's child: its transform undoes the
        // parent's mirror and 100x scale, then scales 3x → world scale 3.
        (3, 1, transform(-0.03, 0.0, 0.0, 0.03, 0.0, -0.5), 3.0, 1.0),
    ] {
        sqlx::query("INSERT INTO items VALUES (?, ?, NULL, ?, NULL, ?, ?, 0, NULL)")
            .bind(parent)
            .bind(id)
            .bind(item)
            .bind(z)
            .bind(opacity)
            .execute(&pool)
            .await
            .expect("item");
    }
    for id in [1_i64, 2] {
        sqlx::query("INSERT INTO items_images VALUES (7, 1.0, ?, 0, ?, NULL, 0, 0)")
            .bind(id)
            .bind(&centred)
            .execute(&pool)
            .await
            .expect("instance");
    }
    sqlx::query("INSERT INTO items_notes VALUES (NULL, 3, ?, '#80ff0000', ?, 0)")
        .bind(size(-1.0, -1.0))
        .bind("<html><body style=\"font-size:20px;\"><p>Stripes &amp; things</p></body></html>")
        .execute(&pool)
        .await
        .expect("note");
    pool.close().await;

    // The container: header, then db[H..N], then db[0..H].
    let database = std::fs::read(&path).expect("read fixture");
    let mut header = qstring("2.1");
    header.extend(0_u32.to_be_bytes());
    let n_at = header.len();
    header.extend(0_u64.to_be_bytes());
    header.extend(qstring("2.1.3"));
    header.extend(qstring(&"0".repeat(32)));
    header.extend(0_u32.to_be_bytes()); // empty thumbnail
    let h = header.len();
    let n = u64::try_from(database.len()).expect("size");
    header[n_at..n_at + 8].copy_from_slice(&n.to_be_bytes());
    let mut file = header;
    file.extend(&database[h..]);
    file.extend(&database[..h]);
    file
}

async fn import(app: &TestApp, bytes: Vec<u8>, name: &str) -> reqwest::Response {
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(bytes).file_name(name.to_string()),
    );
    app.client
        .post(format!("{}/api/boards:import", app.base_url))
        .multipart(form)
        .send()
        .await
        .expect("import request")
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

#[tokio::test]
async fn a_pureref_board_imports_with_its_layout() {
    let app = spawn_app().await;
    let file = build_pur(app.dir.path()).await;
    let response = import(&app, file, "Moodboard.pur").await;
    assert_eq!(response.status(), 201);
    let result: Value = response.json().await.expect("json");
    assert_eq!(result["name"], "Moodboard");
    assert_eq!(result["images"], 2);
    assert_eq!(result["notes"], 1);

    let board: Value = app
        .client
        .get(format!(
            "{}/api/boards/{}",
            app.base_url,
            result["board_id"].as_str().expect("id")
        ))
        .send()
        .await
        .expect("board")
        .json()
        .await
        .expect("board json");
    assert_eq!(
        board["blobs"].as_array().expect("blobs").len(),
        1,
        "one shared blob"
    );
    let items = board["items"].as_array().expect("items");
    let mut items: Vec<&Value> = items.iter().collect();
    items.sort_by_key(|item| item["z_index"].as_i64());
    let (back, front) = (items[0], items[1]);

    // Back to front, as PureRef stacked them (z 1 under z 2).
    assert!(close(back["width"].as_f64().expect("w"), 100.0));
    assert!(close(back["height"].as_f64().expect("h"), 50.0));
    assert!(
        close(back["x"].as_f64().expect("x"), -50.0),
        "centred on the origin"
    );
    assert!(close(
        back["metadata"]["opacity"].as_f64().expect("opacity"),
        0.5
    ));

    assert!(close(front["width"].as_f64().expect("w"), 200.0));
    assert!(close(front["height"].as_f64().expect("h"), 100.0));
    assert!(close(front["x"].as_f64().expect("x"), 400.0));
    assert!(close(front["y"].as_f64().expect("y"), 250.0));
    assert_eq!(front["metadata"]["flip_x"], true, "the mirror comes across");
    assert!(close(front["rotation"].as_f64().expect("rotation"), 0.0));

    let note = &board["notes"][0];
    assert_eq!(note["content_json"]["text"], "Stripes & things");
    // PureRef 20px text at world scale 3 → RefThing 15px × 4.
    assert!(close(
        note["content_json"]["scale"].as_f64().expect("scale"),
        4.0
    ));
    assert_eq!(note["bg_color"], "#ff0000");
    assert!((note["opacity"].as_f64().expect("opacity") - 128.0 / 255.0).abs() < 1e-3);
    assert!(
        close(note["x"].as_f64().expect("x"), 500.0),
        "the parent's centre"
    );
    assert!(
        close(note["y"].as_f64().expect("y"), 250.0),
        "the parent's top edge"
    );
    let top = board["notes"][0]["z_index"].as_i64().expect("z");
    assert!(
        top > front["z_index"].as_i64().expect("z"),
        "the note paints on top"
    );
}

#[tokio::test]
async fn files_that_are_not_boards_are_refused_plainly() {
    let app = spawn_app().await;
    let response = import(&app, b"just some text, not a board".to_vec(), "notes.pur").await;
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.expect("json");
    let message = body["error"]["message"].as_str().expect("message");
    assert!(
        message.contains("not a PureRef board"),
        "message: {message}"
    );
}
