#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use refthing_core::AppConfig;
use tauri::ipc::CapabilityBuilder;
use tauri::window::{Effect, EffectsBuilder};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

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
];

/// The machine-local link shim (`.cargo/config.toml` + `backend/target/`)
/// replaces the MSVC CRT startup, so static initializers in the
/// `.CRT$XC*`/`.CRT$XI*` sections never run. tao records the main thread ID in
/// one (`.CRT$XCU`) and panics without it — run them manually at startup.
#[cfg(windows)]
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

/// Sender that stops the embedded axum server when the app exits.
struct ServerShutdown(Mutex<Option<tokio::sync::oneshot::Sender<()>>>);

fn server_config(app: &tauri::App) -> AppConfig {
    // `cfg!(dev)` is on for `tauri dev` builds (the CLI drops default
    // features) and off for release builds. (NOT `tauri::is_dev()` — that
    // only reflects the custom-protocol feature.)
    if cfg!(dev) {
        // Dev shares the repo's working database; Vite serves the frontend.
        AppConfig {
            data_dir: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data"),
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
    #[cfg(windows)]
    crt_init::run();

    tauri::Builder::default()
        .setup(|app| {
            let config = server_config(app);
            let addr = format!("{}:{}", config.host, config.port);
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            app.manage(ServerShutdown(Mutex::new(Some(tx))));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let shutdown = async move {
                    rx.await.ok();
                };
                if let Err(error) = refthing_server::run_with_shutdown(config, shutdown).await {
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
            let capability = WINDOW_PERMISSIONS.iter().fold(
                CapabilityBuilder::new("main-window")
                    .remote(format!("{origin}/*"))
                    .window("main"),
                |capability, permission| capability.permission(*permission),
            );
            app.add_capability(capability)?;

            // Frameless and transparent: the page draws its own window
            // controls and drag strip (ui-design.md), and the workspace shows
            // the Mica backdrop through it when glass is on (the page turns
            // the effect off with the glass setting).
            let url = WebviewUrl::External(origin.parse().expect("app url"));
            WebviewWindowBuilder::new(app, "main", url)
                .title("RefThing")
                .inner_size(1440.0, 900.0)
                .min_inner_size(420.0, 320.0)
                .decorations(false)
                .shadow(true)
                .transparent(true)
                .effects(EffectsBuilder::new().effect(Effect::Mica).build())
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the RefThing app")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event
                && let Some(shutdown) = app.try_state::<ServerShutdown>()
                && let Some(tx) = shutdown.0.lock().ok().and_then(|mut slot| slot.take())
            {
                // Best-effort graceful stop; the process exits right after.
                tx.send(()).ok();
            }
        });
}
