//! End-to-end API tests for the boards/groups/notes/tags routes: CRUD
//! round-trips, snapshot hydration shape, and the `/changes` event feed.

use std::sync::Arc;

use refthing_core::db::{blobs, groups, items, notes, tags};
use refthing_core::models::ItemMetadata;
use refthing_core::pipeline::ResizePool;
use refthing_core::storage::BlobStore;
use refthing_core::{AppConfig, db};
use refthing_server::events::BroadcastHub;
use refthing_server::jobs::{JobContext, JobQueue, PyramidJob};
use refthing_server::state::AppState;
use serde_json::{Value, json};
use uuid::Uuid;

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

struct TestApp {
    base: String,
    state: AppState,
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
        state,
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
async fn board_crud_round_trip() {
    let app = spawn_app().await;

    let board = create_board(&app, "alpha").await;
    let id = id_of(&board);
    assert_eq!(board["name"], "alpha");
    assert_eq!(board["seq"], 0);
    assert!(board["created_at"].as_i64().expect("epoch ms") > 0);

    // List shows the new board with zero items.
    let summaries = get_json(&app, "/api/boards").await;
    let summaries = summaries.as_array().expect("array");
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0]["name"], "alpha");
    assert_eq!(summaries[0]["item_count"], 0);

    // PATCH renames and persists the viewport; each mutation bumps seq once.
    let response = client()
        .patch(format!("{}/api/boards/{id}", app.base))
        .json(&json!({"name": "beta", "viewport_state": {"x": 1.0, "y": 2.0, "zoom": 3.0}}))
        .send()
        .await
        .expect("patch");
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("json");
    assert_eq!(body["seq"], 1);
    assert_eq!(body["board"]["name"], "beta");
    assert_eq!(body["board"]["viewport_state"]["zoom"], 3.0);

    // Explicit null resets the viewport to the default view.
    let response = client()
        .patch(format!("{}/api/boards/{id}", app.base))
        .json(&json!({"viewport_state": null}))
        .send()
        .await
        .expect("patch viewport reset");
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("json");
    assert_eq!(body["seq"], 2);
    assert!(body["board"]["viewport_state"].is_null());

    // Snapshot reflects the mutations.
    let snapshot = get_json(&app, &format!("/api/boards/{id}")).await;
    assert_eq!(snapshot["board"]["name"], "beta");
    assert_eq!(snapshot["seq"], 2);
    assert_eq!(snapshot["items"].as_array().expect("items").len(), 0);

    // Validation and unknown-id behaviour.
    expect_status(
        &app,
        "PATCH",
        &format!("/api/boards/{id}"),
        Some(&json!({})),
        400,
    )
    .await;
    expect_status(
        &app,
        "PATCH",
        &format!("/api/boards/{id}"),
        Some(&json!({"name": "  "})),
        400,
    )
    .await;
    expect_status(&app, "POST", "/api/boards", Some(&json!({"name": ""})), 400).await;

    // Delete, then everything 404s.
    expect_status(&app, "DELETE", &format!("/api/boards/{id}"), None, 204).await;
    expect_status(&app, "DELETE", &format!("/api/boards/{id}"), None, 404).await;
    expect_status(&app, "GET", &format!("/api/boards/{id}"), None, 404).await;
    assert_eq!(
        get_json(&app, "/api/boards")
            .await
            .as_array()
            .expect("array")
            .len(),
        0
    );
}

#[tokio::test]
async fn snapshot_hydration_shape() {
    let app = spawn_app().await;
    let board = create_board(&app, "moodboard").await;
    let board_id = Uuid::parse_str(id_of(&board)).expect("uuid");

    // Seed content straight through the core db layer (no HTTP surface for
    // items exists in this test's scope).
    let group = groups::create(&app.state.pools.write, board_id, None, "cluster")
        .await
        .expect("group");
    blobs::insert_or_ignore(
        &app.state.pools.write,
        HASH_A,
        Some("ref.png"),
        "image/png",
        4096,
        Some(800),
        Some(600),
    )
    .await
    .expect("blob");
    let item = items::create(
        &app.state.pools.write,
        items::NewItem {
            board_id,
            item_type: "image".to_string(),
            blob_id: Some(HASH_A.to_string()),
            x: 10.0,
            y: 20.0,
            width: 800.0,
            height: 600.0,
            rotation: 0.0,
            z_index: 0,
            group_id: Some(group.id),
        },
    )
    .await
    .expect("item");
    items::set_metadata(
        &app.state.pools.write,
        item.id,
        &ItemMetadata::Image {
            phash: Some("a1b2".to_string()),
            dominant_colors: vec!["#112233".to_string()],
        },
    )
    .await
    .expect("metadata");
    let tag = tags::create(&app.state.pools.write, "Portrait", Some("#ff0000"))
        .await
        .expect("tag");
    tags::add_to_item(&app.state.pools.write, item.id, tag.id)
        .await
        .expect("add tag");
    notes::create(
        &app.state.pools.write,
        board_id,
        1.0,
        2.0,
        300.0,
        200.0,
        json!({"text": "hello"}),
    )
    .await
    .expect("note");

    let snapshot = get_json(&app, &format!("/api/boards/{board_id}")).await;
    assert_eq!(snapshot["board"]["id"], board_id.to_string());
    // Direct core writes bypass the event log, so seq stays 0.
    assert_eq!(snapshot["seq"], 0);

    let snapshot_items = snapshot["items"].as_array().expect("items");
    assert_eq!(snapshot_items.len(), 1);
    let snap_item = &snapshot_items[0];
    assert_eq!(snap_item["type"], "image");
    assert_eq!(snap_item["blob_hash"], HASH_A);
    assert_eq!(snap_item["group_id"], group.id.to_string());
    assert_eq!(snap_item["metadata"]["kind"], "image");
    assert_eq!(snap_item["metadata"]["phash"], "a1b2");

    let snapshot_groups = snapshot["groups"].as_array().expect("groups");
    assert_eq!(snapshot_groups.len(), 1);
    assert_eq!(snapshot_groups[0]["name"], "cluster");

    let snapshot_notes = snapshot["notes"].as_array().expect("notes");
    assert_eq!(snapshot_notes.len(), 1);
    assert_eq!(snapshot_notes[0]["content_json"]["text"], "hello");
    assert_eq!(snapshot_notes[0]["opacity"], 1.0);

    let snapshot_tags = snapshot["tags"].as_array().expect("tags");
    assert!(
        snapshot_tags
            .iter()
            .any(|tag| tag["name"] == "Portrait" && tag["color"] == "#ff0000")
    );

    assert_eq!(
        snapshot["item_tags"][item.id.to_string()],
        json!([tag.id.to_string()])
    );

    let snapshot_blobs = snapshot["blobs"].as_array().expect("blobs");
    assert_eq!(snapshot_blobs.len(), 1);
    assert_eq!(snapshot_blobs[0]["hash"], HASH_A);
    assert_eq!(snapshot_blobs[0]["mime_type"], "image/png");
    assert_eq!(
        snapshot_blobs[0]["levels"]["full"],
        json!({"width": 800, "height": 600})
    );

    // The board list picks up the item count.
    let summaries = get_json(&app, "/api/boards").await;
    assert_eq!(summaries[0]["item_count"], 1);
}

#[tokio::test]
async fn changes_since_returns_events_in_order() {
    let app = spawn_app().await;
    let board = create_board(&app, "events").await;
    let id = id_of(&board);

    // Three board-scoped mutations -> seq 1, 2, 3.
    let group = client()
        .post(format!("{}/api/boards/{id}/groups", app.base))
        .json(&json!({"name": "g"}))
        .send()
        .await
        .expect("create group");
    assert_eq!(group.status(), 201);
    assert_eq!(group.json::<Value>().await.expect("json")["seq"], 1);

    let note = client()
        .post(format!("{}/api/boards/{id}/notes", app.base))
        .json(&json!({"width": 100.0, "height": 50.0}))
        .send()
        .await
        .expect("create note");
    assert_eq!(note.status(), 201);
    assert_eq!(note.json::<Value>().await.expect("json")["seq"], 2);

    expect_status(
        &app,
        "PATCH",
        &format!("/api/boards/{id}"),
        Some(&json!({"name": "renamed"})),
        200,
    )
    .await;

    let changes = get_json(&app, &format!("/api/boards/{id}/changes?since=0")).await;
    assert_eq!(changes["seq"], 3);
    let events = changes["events"].as_array().expect("events");
    assert_eq!(
        events
            .iter()
            .map(|event| event["seq"].as_i64().expect("seq"))
            .collect::<Vec<_>>(),
        [1, 2, 3]
    );
    assert_eq!(events[0]["ops"][0]["kind"], "create_group");
    assert_eq!(events[1]["ops"][0]["kind"], "create_note");
    assert_eq!(events[2]["ops"][0]["kind"], "update_board");
    assert_eq!(events[2]["ops"][0]["name"], "renamed");
    assert!(events.iter().all(|event| event["origin"].is_null()));

    // `since` filters strictly greater, in order; missing `since` means 0.
    let tail = get_json(&app, &format!("/api/boards/{id}/changes?since=1")).await;
    let tail_events = tail["events"].as_array().expect("events");
    assert_eq!(tail_events.len(), 2);
    assert_eq!(tail_events[0]["seq"], 2);

    let current = get_json(&app, &format!("/api/boards/{id}/changes?since=3")).await;
    assert_eq!(current["events"].as_array().expect("events").len(), 0);

    let all = get_json(&app, &format!("/api/boards/{id}/changes")).await;
    assert_eq!(all["events"].as_array().expect("events").len(), 3);

    expect_status(
        &app,
        "GET",
        &format!("/api/boards/{}/changes", Uuid::now_v7()),
        None,
        404,
    )
    .await;
}

async fn post_group(app: &TestApp, board_id: &str, body: Value) -> Value {
    let response = client()
        .post(format!("{}/api/boards/{board_id}/groups", app.base))
        .json(&body)
        .send()
        .await
        .expect("create group");
    assert_eq!(response.status(), 201);
    response.json().await.expect("json")
}

async fn patch_group(app: &TestApp, board_id: &str, group_id: &str, body: Value) -> Value {
    let response = client()
        .patch(format!(
            "{}/api/boards/{board_id}/groups/{group_id}",
            app.base
        ))
        .json(&body)
        .send()
        .await
        .expect("patch group");
    assert_eq!(response.status(), 200);
    response.json().await.expect("json")
}

#[tokio::test]
async fn group_crud_and_patch() {
    let app = spawn_app().await;
    let board = create_board(&app, "groups").await;
    let board_id = id_of(&board).to_string();

    let first = post_group(&app, &board_id, json!({"name": "a"})).await;
    assert_eq!(first["seq"], 1);
    let first_id = id_of(&first["group"]).to_string();

    let second = post_group(
        &app,
        &board_id,
        json!({"name": "b", "parent_group_id": first_id}),
    )
    .await;
    let second_id = id_of(&second["group"]).to_string();
    assert_eq!(second["group"]["parent_group_id"], first_id);
    assert_eq!(second["group"]["collapsed"], false);
    assert_eq!(second["group"]["opacity"], 1.0);

    // Partial patch: name + collapsed, parent untouched.
    let patched = patch_group(
        &app,
        &board_id,
        &second_id,
        json!({"name": "B", "collapsed": true}),
    )
    .await;
    assert_eq!(patched["group"]["name"], "B");
    assert_eq!(patched["group"]["collapsed"], true);
    assert_eq!(patched["group"]["parent_group_id"], first_id);

    // Explicit null moves the group to the root.
    let reparented = patch_group(
        &app,
        &board_id,
        &second_id,
        json!({"parent_group_id": null}),
    )
    .await;
    assert!(reparented["group"]["parent_group_id"].is_null());

    // Delete removes it from the snapshot; a second delete 404s.
    expect_status(
        &app,
        "DELETE",
        &format!("/api/boards/{board_id}/groups/{second_id}"),
        None,
        204,
    )
    .await;
    expect_status(
        &app,
        "DELETE",
        &format!("/api/boards/{board_id}/groups/{second_id}"),
        None,
        404,
    )
    .await;
    let snapshot = get_json(&app, &format!("/api/boards/{board_id}")).await;
    let remaining = snapshot["groups"].as_array().expect("groups");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0]["id"], first_id);
}

#[tokio::test]
async fn group_patch_rejections() {
    let app = spawn_app().await;
    let board = create_board(&app, "groups").await;
    let board_id = id_of(&board).to_string();
    let first = post_group(&app, &board_id, json!({"name": "a"})).await;
    let first_id = id_of(&first["group"]).to_string();
    let second = post_group(&app, &board_id, json!({"name": "b"})).await;
    let second_id = id_of(&second["group"]).to_string();

    // Empty patch, self-parent, unknown group, unknown board.
    expect_status(
        &app,
        "PATCH",
        &format!("/api/boards/{board_id}/groups/{second_id}"),
        Some(&json!({})),
        400,
    )
    .await;
    expect_status(
        &app,
        "PATCH",
        &format!("/api/boards/{board_id}/groups/{second_id}"),
        Some(&json!({"parent_group_id": second_id})),
        400,
    )
    .await;
    expect_status(
        &app,
        "PATCH",
        &format!("/api/boards/{board_id}/groups/{}", Uuid::now_v7()),
        Some(&json!({"name": "nope"})),
        404,
    )
    .await;
    expect_status(
        &app,
        "POST",
        &format!("/api/boards/{}/groups", Uuid::now_v7()),
        Some(&json!({"name": "nope"})),
        404,
    )
    .await;

    // A parent from another board is rejected both on create and on patch.
    let other_board = create_board(&app, "other").await;
    let other_board_id = id_of(&other_board).to_string();
    expect_status(
        &app,
        "POST",
        &format!("/api/boards/{other_board_id}/groups"),
        Some(&json!({"parent_group_id": first_id})),
        400,
    )
    .await;
    expect_status(
        &app,
        "PATCH",
        &format!("/api/boards/{board_id}/groups/{second_id}"),
        Some(&json!({"parent_group_id": first_id, "name": "ok"})),
        200,
    )
    .await;
    let foreign = post_group(&app, &other_board_id, json!({"name": "foreign"})).await;
    expect_status(
        &app,
        "PATCH",
        &format!("/api/boards/{board_id}/groups/{second_id}"),
        Some(&json!({"parent_group_id": id_of(&foreign["group"])})),
        400,
    )
    .await;
}

#[tokio::test]
async fn note_crud_and_update() {
    let app = spawn_app().await;
    let board = create_board(&app, "notes").await;
    let board_id = id_of(&board);

    let created: Value = client()
        .post(format!("{}/api/boards/{board_id}/notes", app.base))
        .json(&json!({
            "x": 5.0, "y": 6.0, "width": 200.0, "height": 100.0,
            "content_json": {"text": "draft"},
            "bg_color": "#334455", "opacity": 0.5,
        }))
        .send()
        .await
        .expect("create note")
        .json()
        .await
        .expect("json");
    assert_eq!(created["seq"], 1);
    let note = &created["note"];
    assert_eq!(note["content_json"]["text"], "draft");
    assert_eq!(note["bg_color"], "#334455");
    assert_eq!(note["opacity"], 0.5);
    let note_id = id_of(note).to_string();

    // Partial patch: geometry + content; explicit null clears bg_color.
    let patched: Value = client()
        .patch(format!(
            "{}/api/boards/{board_id}/notes/{note_id}",
            app.base
        ))
        .json(&json!({"x": 7.0, "content_json": {"text": "final"}, "bg_color": null}))
        .send()
        .await
        .expect("patch note")
        .json()
        .await
        .expect("json");
    assert_eq!(patched["seq"], 2);
    assert_eq!(patched["note"]["x"], 7.0);
    assert_eq!(patched["note"]["y"], 6.0);
    assert_eq!(patched["note"]["content_json"]["text"], "final");
    assert!(patched["note"]["bg_color"].is_null());
    assert_eq!(patched["note"]["opacity"], 0.5);

    expect_status(
        &app,
        "PATCH",
        &format!("/api/boards/{board_id}/notes/{note_id}"),
        Some(&json!({})),
        400,
    )
    .await;
    expect_status(
        &app,
        "PATCH",
        &format!("/api/boards/{board_id}/notes/{}", Uuid::now_v7()),
        Some(&json!({"x": 1.0})),
        404,
    )
    .await;
    expect_status(
        &app,
        "POST",
        &format!("/api/boards/{}/notes", Uuid::now_v7()),
        Some(&json!({"width": 1.0, "height": 1.0})),
        404,
    )
    .await;

    expect_status(
        &app,
        "DELETE",
        &format!("/api/boards/{board_id}/notes/{note_id}"),
        None,
        204,
    )
    .await;
    expect_status(
        &app,
        "DELETE",
        &format!("/api/boards/{board_id}/notes/{note_id}"),
        None,
        404,
    )
    .await;
    let snapshot = get_json(&app, &format!("/api/boards/{board_id}")).await;
    assert_eq!(snapshot["notes"].as_array().expect("notes").len(), 0);
}

/// Items and notes share ONE paint order (the canvas interleaves them), so
/// a new node of either kind lands above both kinds.
#[tokio::test]
async fn new_items_and_notes_share_one_z_stack() {
    let app = spawn_app().await;
    let board = create_board(&app, "z-stack").await;
    let board_id = id_of(&board);
    let post = |path: &'static str, body: Value| {
        let url = format!("{}/api/boards/{board_id}/{path}", app.base);
        async move {
            client()
                .post(url)
                .json(&body)
                .send()
                .await
                .expect("post")
                .json::<Value>()
                .await
                .expect("json")
        }
    };
    let geometry = json!({"type": "image", "x": 0.0, "y": 0.0, "width": 10.0, "height": 10.0});
    let first = post("items", geometry.clone()).await;
    let note = post("notes", json!({"width": 10.0, "height": 10.0})).await;
    let second = post("items", geometry).await;
    let pinned = post(
        "notes",
        json!({"width": 10.0, "height": 10.0, "z_index": -5}),
    )
    .await;

    let z = |value: &Value, key: &str| value[key]["z_index"].as_i64().expect("z_index");
    assert_eq!(z(&first, "item"), 0);
    assert_eq!(z(&note, "note"), 1, "a new note lands above existing items");
    assert_eq!(
        z(&second, "item"),
        2,
        "a new item lands above existing notes"
    );
    assert_eq!(z(&pinned, "note"), -5, "an explicit z_index is kept");
}

/// Item metadata updates are JSON merge patches (RFC 7396): a client edit
/// must never wipe keys the pyramid job merged in (palette, phash).
#[tokio::test]
async fn item_metadata_patch_merges() {
    let app = spawn_app().await;
    let board = create_board(&app, "metadata").await;
    let board_id = id_of(&board);
    let created: Value = client()
        .post(format!("{}/api/boards/{board_id}/items", app.base))
        .json(&json!({
            "type": "image", "x": 0.0, "y": 0.0, "width": 10.0, "height": 10.0,
            "metadata": {"phash": "a1b2", "dominant_colors": ["#ff0000"]},
        }))
        .send()
        .await
        .expect("create")
        .json()
        .await
        .expect("json");
    let item_id = id_of(&created["item"]).to_string();
    let patch = |metadata: Value| {
        let url = format!("{}/api/boards/{board_id}/items/{item_id}", app.base);
        async move {
            client()
                .patch(url)
                .json(&json!({ "metadata": metadata }))
                .send()
                .await
                .expect("patch")
                .json::<Value>()
                .await
                .expect("json")
        }
    };

    let flipped = patch(json!({"flip_x": true, "opacity": 0.5})).await;
    assert_eq!(
        flipped["item"]["metadata"],
        json!({"phash": "a1b2", "dominant_colors": ["#ff0000"], "flip_x": true, "opacity": 0.5}),
        "new keys merge in; pipeline keys survive"
    );
    let cleared = patch(json!({"flip_x": null})).await;
    assert_eq!(
        cleared["item"]["metadata"],
        json!({"phash": "a1b2", "dominant_colors": ["#ff0000"], "opacity": 0.5}),
        "null deletes exactly that key"
    );
}

/// §6 RULE 3: locking is a batch op (so it rides undo), round-trips through
/// the snapshot, and rejects unknown groups without bumping seq.
#[tokio::test]
async fn group_lock_is_a_batch_op() {
    let app = spawn_app().await;
    let board = create_board(&app, "locks").await;
    let board_id = id_of(&board);
    let group = post_group(&app, board_id, json!({"name": "g"})).await;
    let group_id = id_of(&group["group"]).to_string();
    let batch = |seq: i64, target: &str, locked: bool| {
        let url = format!("{}/api/boards/{board_id}/items/batch", app.base);
        let body = json!({
            "base_seq": seq,
            "client_id": "t",
            "ops": [{"kind": "set_group_locked", "op_id": Uuid::now_v7(),
                     "group_id": target, "locked": locked}],
        });
        async move {
            client()
                .post(url)
                .json(&body)
                .send()
                .await
                .expect("batch")
                .json::<Value>()
                .await
                .expect("json")
        }
    };
    let seq = group["seq"].as_i64().expect("seq");
    let locked = batch(seq, &group_id, true).await;
    assert_eq!(locked["rejected"], json!([]));
    let snapshot = get_json(&app, &format!("/api/boards/{board_id}")).await;
    assert_eq!(snapshot["groups"][0]["locked"], true);

    // Group background style rides the same batch path; bad opacity rejects.
    let styled: Value = client()
        .post(format!("{}/api/boards/{board_id}/items/batch", app.base))
        .json(&json!({
            "base_seq": locked["seq"],
            "client_id": "t",
            "ops": [
                {"kind": "set_group_style", "op_id": Uuid::now_v7(), "group_id": group_id,
                 "bg_color": "#223344", "opacity": 0.4},
                {"kind": "set_group_style", "op_id": Uuid::now_v7(), "group_id": group_id,
                 "bg_color": null, "opacity": 7.0},
            ],
        }))
        .send()
        .await
        .expect("style")
        .json()
        .await
        .expect("json");
    assert_eq!(styled["rejected"][0]["reason"], "invalid_opacity");
    let snapshot = get_json(&app, &format!("/api/boards/{board_id}")).await;
    assert_eq!(snapshot["groups"][0]["bg_color"], "#223344");
    assert_eq!(snapshot["groups"][0]["opacity"], 0.4);

    let missing = batch(
        styled["seq"].as_i64().expect("seq"),
        &Uuid::now_v7().to_string(),
        true,
    )
    .await;
    assert_eq!(missing["rejected"][0]["reason"], "group_not_found");
    assert_eq!(
        missing["seq"], styled["seq"],
        "an all-rejected batch bumps nothing"
    );
}

/// A viewport save carries the sender's client id as the event origin, so
/// the sender's WebSocket recognises its own echo instead of refetching.
#[tokio::test]
async fn board_patch_records_client_origin() {
    let app = spawn_app().await;
    let board = create_board(&app, "origin").await;
    let board_id = id_of(&board);
    let response = client()
        .patch(format!("{}/api/boards/{board_id}", app.base))
        .json(&json!({"viewport_state": {"x": 1.0, "y": 2.0, "zoom": 1.0}, "client_id": "me"}))
        .send()
        .await
        .expect("patch");
    assert_eq!(response.status(), 200);
    let changes = get_json(&app, &format!("/api/boards/{board_id}/changes?since=0")).await;
    let events = changes["events"].as_array().expect("events");
    assert_eq!(events.last().expect("event")["origin"], "me");
}

#[tokio::test]
async fn tag_crud() {
    let app = spawn_app().await;

    assert_eq!(get_json(&app, "/api/tags").await, json!([]));

    let created: Value = client()
        .post(format!("{}/api/tags", app.base))
        .json(&json!({"name": "Mood", "color": "#123456"}))
        .send()
        .await
        .expect("create tag")
        .json()
        .await
        .expect("json");
    assert_eq!(created["name"], "Mood");
    assert_eq!(created["color"], "#123456");
    let tag_id = id_of(&created).to_string();

    // Duplicate names are a 409 (case-insensitive), empty names a 400.
    expect_status(
        &app,
        "POST",
        "/api/tags",
        Some(&json!({"name": "mood"})),
        409,
    )
    .await;
    expect_status(&app, "POST", "/api/tags", Some(&json!({"name": "  "})), 400).await;

    // Patch: rename + clear color via explicit null.
    let patched: Value = client()
        .patch(format!("{}/api/tags/{tag_id}", app.base))
        .json(&json!({"name": "Ambience", "color": null}))
        .send()
        .await
        .expect("patch tag")
        .json()
        .await
        .expect("json");
    assert_eq!(patched["name"], "Ambience");
    assert!(patched["color"].is_null());

    // Tag CRUD never bumps a board seq (tags are global).
    let board = create_board(&app, "seq check").await;
    let snapshot = get_json(&app, &format!("/api/boards/{}", id_of(&board))).await;
    assert_eq!(snapshot["seq"], 0);

    expect_status(
        &app,
        "PATCH",
        &format!("/api/tags/{tag_id}"),
        Some(&json!({})),
        400,
    )
    .await;
    expect_status(
        &app,
        "PATCH",
        &format!("/api/tags/{}", Uuid::now_v7()),
        Some(&json!({"name": "x"})),
        404,
    )
    .await;

    let tags = get_json(&app, "/api/tags").await;
    assert_eq!(tags.as_array().expect("array").len(), 1);

    expect_status(&app, "DELETE", &format!("/api/tags/{tag_id}"), None, 204).await;
    expect_status(&app, "DELETE", &format!("/api/tags/{tag_id}"), None, 404).await;
    assert_eq!(get_json(&app, "/api/tags").await, json!([]));
}

#[tokio::test]
async fn unknown_board_is_404_everywhere() {
    let app = spawn_app().await;
    let missing = Uuid::now_v7();

    expect_status(&app, "GET", &format!("/api/boards/{missing}"), None, 404).await;
    expect_status(
        &app,
        "PATCH",
        &format!("/api/boards/{missing}"),
        Some(&json!({"name": "x"})),
        404,
    )
    .await;
    expect_status(&app, "DELETE", &format!("/api/boards/{missing}"), None, 404).await;
    expect_status(
        &app,
        "GET",
        &format!("/api/boards/{missing}/changes"),
        None,
        404,
    )
    .await;
    expect_status(
        &app,
        "POST",
        &format!("/api/boards/{missing}/groups"),
        Some(&json!({"name": "g"})),
        404,
    )
    .await;
    expect_status(
        &app,
        "POST",
        &format!("/api/boards/{missing}/notes"),
        Some(&json!({"width": 1.0, "height": 1.0})),
        404,
    )
    .await;
}
