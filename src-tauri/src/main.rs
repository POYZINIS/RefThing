#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use refthing_core::AppConfig;
use tauri::ipc::CapabilityBuilder;
use tauri::window::{Color, Effect, EffectsBuilder};

/// Acrylic's own tint, kept faint: the page's workspace colour (with the
/// Settings → Background opacity) does the tinting on top of the blur.
const ACRYLIC_TINT: Color = Color(26, 31, 41, 24);
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// What the page may do with its own window. The page is served over HTTP
/// (the embedded server, or Vite in dev), so Tauri treats it as a REMOTE
/// origin: these grants are scoped to exactly that origin at runtime.
const WINDOW_PERMISSIONS: &[&str] = &[
    "core:default",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-set-always-on-top",
    "core:window:allow-start-dragging",
    "core:window:allow-set-position",
    "core:window:allow-set-effects",
    // Updates: check the GitHub release, download and install (signed).
    "updater:default",
    // `.ref` board files: where to save one, which one to open.
    "dialog:allow-save",
    "dialog:allow-open",
];

/// The machine-local link shim (`.cargo/config.toml` + `backend/target/`)
/// replaces the MSVC CRT startup, so static initializers in the
/// `.CRT$XC*`/`.CRT$XI*` sections never run. tao records the main thread ID in
/// one (`.CRT$XCU`) and panics without it — run them manually at startup.
// Only for a build linked through that shim (its machine-local cargo config
// passes `--cfg refthing_link_shim`): a normal MSVC build — every release —
// has already run the initializers, and must not run them twice.
#[cfg(all(windows, refthing_link_shim))]
mod crt_init {
    #[unsafe(link_section = ".CRT$XCA")]
    #[used]
    static INIT_BEGIN: usize = 0;
    #[unsafe(link_section = ".CRT$XIY")]
    #[used]
    static INIT_END: usize = 0;

    pub fn run() {
        let begin = std::ptr::from_ref(&INIT_BEGIN) as usize + size_of::<usize>();
        let end = std::ptr::from_ref(&INIT_END) as usize;
        let mut cursor = begin;
        while cursor < end {
            let initializer = unsafe { *(cursor as *const usize) };
            if initializer != 0 {
                unsafe { std::mem::transmute::<usize, extern "C" fn()>(initializer)() };
            }
            cursor += size_of::<usize>();
        }
    }
}

/// Stops the embedded server when the app exits, and hears when it's done
/// (its last job is writing any linked `.ref` file that's behind).
struct ServerLife {
    shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    done: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

/// How long closing waits for the server to finish writing board files.
const FLUSH_TIMEOUT: Duration = Duration::from_secs(30);

/// A `.ref` file among the launch arguments (a double-click in Explorer).
fn board_file_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|arg| {
            std::path::Path::new(arg)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("ref"))
        })
        .cloned()
}

fn server_config(app: &tauri::App) -> AppConfig {
    // Every board is kept as a .ref file, by default in Documents\RefThing
    // (created on first write; Settings → Board files changes it).
    let boards_dir = app
        .path()
        .document_dir()
        .ok()
        .map(|documents| documents.join("RefThing"));
    // `cfg!(dev)` is on for `tauri dev` builds (the CLI drops default
    // features) and off for release builds. (NOT `tauri::is_dev()` — that
    // only reflects the custom-protocol feature.)
    if cfg!(dev) {
        // Dev shares the repo's working database; Vite serves the frontend.
        AppConfig {
            data_dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data"),
            boards_dir,
            ..AppConfig::default()
        }
    } else {
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("data"));
        let static_dir = app.path().resource_dir().ok().map(|dir| dir.join("dist"));
        AppConfig {
            static_dir,
            data_dir,
            boards_dir,
            ..AppConfig::default()
        }
    }
}

/// Block until the embedded server accepts connections (it usually binds
/// within a few hundred milliseconds; the window must not open before it).
fn wait_for_server(addr: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(addr).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "the embedded server did not start on {addr} within {}s — is something else already using port 7171?",
        timeout.as_secs()
    ))
}

fn main() {
    #[cfg(all(windows, refthing_link_shim))]
    crt_init::run();

    tauri::Builder::default()
        // First: a second launch (another .ref double-clicked) hands its
        // file to this window and exits, instead of starting a second server.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(path) = board_file_arg(&args) {
                    window.emit("open-board-file", path).ok();
                }
                window.unminimize().ok();
                window.set_focus().ok();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Only the page's own requests open files; links aren't hijacked.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            let config = server_config(app);
            // Where the server puts the named copies of files to open
            // (`routes/originals.rs`) — the only paths the page may open.
            let opened = config.data_dir.join("opened");
            let addr = format!("{}:{}", config.host, config.port);
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
            app.manage(ServerLife {
                shutdown: Mutex::new(Some(tx)),
                done: Mutex::new(Some(done_rx)),
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let shutdown = async move {
                    rx.await.ok();
                };
                let result = refthing_server::run_with_shutdown(config, shutdown).await;
                done_tx.send(()).ok();
                if let Err(error) = result {
                    eprintln!("embedded server failed: {error:#}");
                    handle.exit(1);
                }
            });

            if let Err(message) = wait_for_server(&addr, Duration::from_secs(30)) {
                eprintln!("{message}");
                return Err(message.into());
            }

            // The webview loads the app over HTTP from the server itself, so
            // the frontend's relative /api, /blob and WebSocket URLs work
            // unchanged. Dev goes through the Vite dev server instead.
            let origin = if cfg!(dev) {
                "http://localhost:5173".to_string()
            } else {
                format!("http://{addr}")
            };
            let capability = WINDOW_PERMISSIONS
                .iter()
                .fold(
                    CapabilityBuilder::new("main-window")
                        .remote(format!("{origin}/*"))
                        .window("main"),
                    |capability, permission| capability.permission(*permission),
                )
                // "Open" on a file card: the server's copy of it, in the
                // system's default app (never a program the page names).
                .permission_scoped(
                    "opener:allow-open-path",
                    vec![serde_json::json!({ "path": format!("{}/**", opened.display()) })],
                    Vec::new(),
                );
            app.add_capability(capability)?;

            // Frameless and transparent: the page draws its own window
            // controls and drag strip (DESIGN.md), and the workspace shows
            // Acrylic through it when glass is on — a real blur of whatever
            // is behind the window (Mica only tints from the wallpaper). The
            // page turns the effect off with the glass setting.
            // The page's address names this version (?v=), so a page the
            // webview cached under an older version is never shown after an
            // update. Launched by opening a .ref file: the page opens it
            // (?open=).
            let mut url: tauri::Url = origin.parse().expect("app url");
            url.query_pairs_mut()
                .append_pair("v", env!("CARGO_PKG_VERSION"));
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = board_file_arg(&args) {
                url.query_pairs_mut().append_pair("open", &path);
            }
            let url = WebviewUrl::External(url);
            WebviewWindowBuilder::new(app, "main", url)
                .title("RefThing")
                .inner_size(1440.0, 900.0)
                .min_inner_size(420.0, 320.0)
                .decorations(false)
                .shadow(true)
                .transparent(true)
                .effects(
                    EffectsBuilder::new()
                        .effect(Effect::Acrylic)
                        .color(ACRYLIC_TINT)
                        .build(),
                )
                // Files dropped on the window reach the page as HTML drag and
                // drop (the board places them where they land). Tauri's own
                // drop handler would swallow them on Windows.
                .disable_drag_drop_handler()
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the RefThing app")
        .run(|app, event| match event {
            // Closing: stop the server and wait for it to finish — it writes
            // any linked .ref file that's behind — then exit. (Everything is
            // already saved in the database; this keeps the files current.)
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => {
                let Some(life) = app.try_state::<ServerLife>() else {
                    return;
                };
                let Some(tx) = life.shutdown.lock().ok().and_then(|mut slot| slot.take()) else {
                    return;
                };
                api.prevent_exit();
                tx.send(()).ok();
                let done = life.done.lock().ok().and_then(|mut slot| slot.take());
                let handle = app.clone();
                std::thread::spawn(move || {
                    if let Some(done) = done {
                        done.recv_timeout(FLUSH_TIMEOUT).ok();
                    }
                    handle.exit(0);
                });
            }
            tauri::RunEvent::Exit => {
                // Any other way out: best-effort stop.
                if let Some(life) = app.try_state::<ServerLife>()
                    && let Some(tx) = life.shutdown.lock().ok().and_then(|mut slot| slot.take())
                {
                    tx.send(()).ok();
                }
            }
            _ => {}
        });
}
