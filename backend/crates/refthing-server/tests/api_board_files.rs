//! `.ref` board files: linking a board to a file writes it (encrypted, with
//! its media), the sync keeps it written after edits, opening it again
//! finds the same board, a file changed elsewhere opens fresh, a dropped
//! `.ref` imports, and only `RefThing`'s own pages may name paths.

use std::sync::Arc;
use std::time::Duration;

use refthing_core::pipeline::ResizePool;
use refthing_core::storage::BlobStore;
use refthing_core::{AppConfig, db};
use refthing_server::events;
use refthing_server::jobs::{JobContext, JobQueue, PyramidJob};
use refthing_server::services::ref_files::RefSync;
use refthing_server::state::AppState;
use serde_json::{Value, json};

struct TestApp {
    base_url: String,
    client: reqwest::Client,
    dir: tempfile::TempDir,
    state: AppState,
}

async fn spawn_app() -> TestApp {
    let dir = tempfile::tempdir().expect("temp dir");
    let data_dir = dir.path().join("data");
    let config = AppConfig {
        host: "127.0.0.1".to_string(),
        port: 0,
        data_dir: data_dir.clone(),
        static_dir: None,
        boards_dir: None,
    };
    std::fs::create_dir_all(&data_dir).expect("data dir");
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
    let app = refthing_server::router::build_router(state.clone());
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
        state,
    }
}

fn png() -> Vec<u8> {
    let mut image = image::RgbImage::new(4, 3);
    image.put_pixel(0, 0, image::Rgb([200, 40, 10]));
    let mut bytes = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, image::ImageFormat::Png)
        .expect("encode png");
    bytes.into_inner()
}

async fn board_with_an_image(app: &TestApp) -> String {
    let created: Value = app
        .client
        .post(format!("{}/api/boards", app.base_url))
        .json(&json!({"name": "Moodboard"}))
        .send()
        .await
        .expect("create")
        .json()
        .await
        .expect("board");
    let board_id = created["board"]["id"]
        .as_str()
        .or_else(|| created["id"].as_str())
        .expect("board id")
        .to_string();
    let form = reqwest::multipart::Form::new()
        .part(
            "meta",
            reqwest::multipart::Part::text(json!({"a.png": {"x": 10.0, "y": 20.0}}).to_string()),
        )
        .part(
            "files",
            reqwest::multipart::Part::bytes(png()).file_name("a.png"),
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
    assert!(response.status().is_success());
    board_id
}

async fn file_status(app: &TestApp, board_id: &str) -> Value {
    app.client
        .get(format!("{}/api/boards/{board_id}/file", app.base_url))
        .send()
        .await
        .expect("status")
        .json()
        .await
        .expect("status body")
}

async fn rename(app: &TestApp, board_id: &str, name: &str) {
    let response = app
        .client
        .patch(format!("{}/api/boards/{board_id}", app.base_url))
        .json(&json!({"name": name}))
        .send()
        .await
        .expect("rename");
    assert!(response.status().is_success());
}

async fn board_names(app: &TestApp) -> Vec<String> {
    let boards: Value = app
        .client
        .get(format!("{}/api/boards", app.base_url))
        .send()
        .await
        .expect("boards")
        .json()
        .await
        .expect("boards body");
    let list = boards["boards"]
        .as_array()
        .or_else(|| boards.as_array())
        .expect("list");
    list.iter()
        .map(|board| board["name"].as_str().unwrap_or_default().to_string())
        .collect()
}

#[tokio::test]
async fn a_linked_board_file_is_written_kept_in_sync_and_reopened() {
    let app = spawn_app().await;
    let board_id = board_with_an_image(&app).await;
    let target = app.dir.path().join("files").join("Moodboard");

    // Link: the file is written now (".ref" added), encrypted, media inside.
    let linked: Value = app
        .client
        .put(format!("{}/api/boards/{board_id}/file", app.base_url))
        .json(&json!({"path": target.to_string_lossy()}))
        .send()
        .await
        .expect("link")
        .json()
        .await
        .expect("linked");
    assert_eq!(linked["saved"], true, "{linked}");
    let path = target.with_extension("ref");
    let bytes = std::fs::read(&path).expect("file written");
    assert!(bytes.starts_with(b"REFBOARD"));
    assert!(bytes.len() > png().len(), "the image is inside");

    // An edit: the file is behind until the sync writes it.
    rename(&app, &board_id, "Moodboard 2").await;
    assert_eq!(file_status(&app, &board_id).await["saved"], false);
    let sync = RefSync::spawn(
        app.state.pools.clone(),
        app.state.config.data_dir.clone(),
        None,
    );
    let mut saved = false;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if file_status(&app, &board_id).await["saved"] == true {
            saved = true;
            break;
        }
    }
    assert!(saved, "the sync caught the file up");
    sync.flush().await;
    assert!(
        std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .all(|entry| entry.unwrap().path() == path),
        "no temp files left beside it"
    );

    // Opening the same file again finds the same board.
    let reopened: Value = app
        .client
        .post(format!("{}/api/boards:open-file", app.base_url))
        .json(&json!({"path": path.to_string_lossy()}))
        .send()
        .await
        .expect("open")
        .json()
        .await
        .expect("opened");
    assert_eq!(reopened["reused"], true);
    assert_eq!(reopened["board_id"], board_id.as_str());
    assert_eq!(reopened["name"], "Moodboard 2");

    // A copy of the file elsewhere opens as a new board, linked to the copy.
    let copy = app.dir.path().join("files").join("Copy.ref");
    std::fs::copy(&path, &copy).expect("copy");
    let opened: Value = app
        .client
        .post(format!("{}/api/boards:open-file", app.base_url))
        .json(&json!({"path": copy.to_string_lossy()}))
        .send()
        .await
        .expect("open copy")
        .json()
        .await
        .expect("opened copy");
    assert_eq!(opened["reused"], false);
    assert_ne!(opened["board_id"], board_id.as_str());
    let copy_id = opened["board_id"].as_str().unwrap().to_string();
    assert_eq!(file_status(&app, &copy_id).await["saved"], true);

    // Dropped on the window (an upload, no path): imported, not linked.
    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(bytes).file_name("Moodboard.ref"),
    );
    let imported: Value = app
        .client
        .post(format!("{}/api/boards:import", app.base_url))
        .multipart(form)
        .send()
        .await
        .expect("import")
        .json()
        .await
        .expect("imported");
    assert_eq!(imported["images"], 1, "{imported}");
    assert_eq!(
        board_names(&app)
            .await
            .iter()
            .filter(|name| name.starts_with("Moodboard"))
            .count(),
        3
    );
}

#[tokio::test]
async fn only_refthing_pages_may_name_paths() {
    let app = spawn_app().await;
    let board_id = board_with_an_image(&app).await;
    let path = app.dir.path().join("evil.ref");
    let response = app
        .client
        .put(format!("{}/api/boards/{board_id}/file", app.base_url))
        .header("Origin", "https://evil.example")
        .json(&json!({"path": path.to_string_lossy()}))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert!(!path.exists());

    let response = app
        .client
        .post(format!("{}/api/boards:open-file", app.base_url))
        .header("Origin", "https://evil.example")
        .json(&json!({"path": path.to_string_lossy()}))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_board_downloads_as_a_ref_file() {
    let app = spawn_app().await;
    let board_id = board_with_an_image(&app).await;
    let response = app
        .client
        .get(format!(
            "{}/api/boards/{board_id}/download.ref",
            app.base_url
        ))
        .send()
        .await
        .expect("download");
    assert!(response.status().is_success());
    assert!(
        response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .contains("Moodboard.ref")
    );
    let bytes = response.bytes().await.expect("bytes");
    assert!(bytes.starts_with(b"REFBOARD"));
    // The temp file is gone once sent.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let tmp = app.state.config.data_dir.join("tmp");
    let left = std::fs::read_dir(&tmp).map_or(0, |entries| {
        entries
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().is_some_and(|x| x == "ref"))
            .count()
    });
    assert_eq!(left, 0);
}

#[tokio::test]
async fn every_board_gets_a_file_in_the_boards_folder() {
    let app = spawn_app().await;
    let documents = app.dir.path().join("Documents");
    std::fs::create_dir_all(&documents).expect("documents");
    // A board made before, and one whose name is taken on disk.
    let first = board_with_an_image(&app).await;
    std::fs::write(documents.join("Taken.ref"), b"someone else's").expect("taken");
    let taken: Value = app
        .client
        .post(format!("{}/api/boards", app.base_url))
        .json(&json!({"name": "Taken"}))
        .send()
        .await
        .expect("create")
        .json()
        .await
        .expect("board");
    let taken_id = taken["id"].as_str().expect("id").to_string();

    // The sync gives boards without a file one in the default folder.
    let sync = RefSync::spawn(
        app.state.pools.clone(),
        app.state.config.data_dir.clone(),
        Some(documents.clone()),
    );
    let mut all_saved = false;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let a = file_status(&app, &first).await;
        let b = file_status(&app, &taken_id).await;
        if a["saved"] == true && b["saved"] == true {
            all_saved = true;
            break;
        }
    }
    assert!(all_saved, "both boards got files");
    assert!(documents.join("Moodboard.ref").is_file());
    assert!(documents.join("Taken (2).ref").is_file(), "a free name");
    assert_eq!(
        std::fs::read(documents.join("Taken.ref")).unwrap(),
        b"someone else's",
        "never overwrites a file that isn't its own"
    );

    // A new board can name its folder.
    let elsewhere = app.dir.path().join("Projects");
    let created: Value = app
        .client
        .post(format!("{}/api/boards", app.base_url))
        .json(&json!({"name": "Client work", "file_folder": elsewhere.to_string_lossy()}))
        .send()
        .await
        .expect("create in folder")
        .json()
        .await
        .expect("board");
    let created_id = created["id"].as_str().expect("id").to_string();
    assert!(
        elsewhere.join("Client work.ref").is_file(),
        "written at once"
    );
    assert_eq!(file_status(&app, &created_id).await["saved"], true);

    // Settings: a new boards folder; the files in the old one move with it.
    let moved = app.dir.path().join("Boards");
    let response = app
        .client
        .put(format!("{}/api/settings/boards-folder", app.base_url))
        .json(&json!({"folder": moved.to_string_lossy()}))
        .send()
        .await
        .expect("set folder");
    assert!(response.status().is_success());
    // (The default here came from the sync, not the server config, so the
    // move is checked by setting a second folder over the first.)
    let again = app.dir.path().join("Boards 2");
    app.client
        .put(format!("{}/api/settings/boards-folder", app.base_url))
        .json(&json!({"folder": again.to_string_lossy()}))
        .send()
        .await
        .expect("set folder again");
    let folder: Value = app
        .client
        .get(format!("{}/api/settings/boards-folder", app.base_url))
        .send()
        .await
        .expect("get folder")
        .json()
        .await
        .expect("folder");
    assert_eq!(folder["folder"], again.to_string_lossy().as_ref());
    sync.flush().await;
    assert!(
        elsewhere.join("Client work.ref").is_file(),
        "files elsewhere stay"
    );
}

#[tokio::test]
async fn changing_the_boards_folder_moves_its_files() {
    let app = spawn_app().await;
    let board_id = board_with_an_image(&app).await;
    let first = app.dir.path().join("First");
    let second = app.dir.path().join("Second");
    // The first folder, then a board kept in it.
    app.client
        .put(format!("{}/api/settings/boards-folder", app.base_url))
        .json(&json!({"folder": first.to_string_lossy()}))
        .send()
        .await
        .expect("set first");
    app.client
        .put(format!("{}/api/boards/{board_id}/file", app.base_url))
        .json(&json!({"path": first.join("Moodboard.ref").to_string_lossy()}))
        .send()
        .await
        .expect("link");
    assert!(first.join("Moodboard.ref").is_file());

    app.client
        .put(format!("{}/api/settings/boards-folder", app.base_url))
        .json(&json!({"folder": second.to_string_lossy()}))
        .send()
        .await
        .expect("set second");
    assert!(
        second.join("Moodboard.ref").is_file(),
        "moved to the new folder"
    );
    assert!(
        !first.join("Moodboard.ref").exists(),
        "and gone from the old one"
    );
    let status = file_status(&app, &board_id).await;
    assert_eq!(status["saved"], true);
    assert!(status["path"].as_str().unwrap().contains("Second"));
}
