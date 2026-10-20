# Prerequisites (Windows)

RefThing targets Windows 11 + Git Bash as the primary development
environment. Everything below assumes Git Bash (Unix syntax: forward
slashes, `/dev/null`).

## Rust (rustup + MSVC toolchain)

Install via [rustup](https://rustup.rs/). The project uses the **MSVC**
toolchain (`stable-x86_64-pc-windows-msvc`), which requires the
**Visual Studio Build Tools** with the **"Desktop development with C++"**
workload installed.

> **This is the #1 setup failure point.** If `cargo build` fails with
> linker errors (`link.exe not found`, `LNK1181`, missing `kernel32.lib`,
> etc.), you are missing the C++ build tools. Install "Visual Studio Build
> Tools" and check the "Desktop development with C++" workload, then open a
> new shell.

Verified working: Rust 1.98.0 MSVC.

## No-MSVC machines (this dev box)

> **Read this if you're on this machine.** It has **no Visual Studio /
> Build Tools installed** — no `link.exe`, no Windows SDK, no MSVC import
> libraries. The guidance above (install VS Build Tools) remains the
> **recommended path for fresh machines**; this box instead uses a shim.

Linking works through a shim that lives entirely inside
`backend/target/`:

- `backend/target/importlibs/` — generated `.lib` import libraries for
  the Windows system DLLs (kernel32, user32, msvcrt, …) plus `stubs.o`,
  an object file supplying the CRT entry-point symbols MSVC would
  normally provide.
- `backend/target/tools/` — a local **zig** copy; `zigcc.bat` /
  `ziglib.bat` stand in for MSVC `cl.exe` / `lib.exe` when compiling C
  dependencies, `zigcxx.bat` stands in for C++ (`zig c++`, exceptions
  disabled — needed by Tauri's `vswhom-sys`), and `rc.bat` wraps
  `zig rc` as an `rc.exe` replacement for Tauri's icon/version resource
  embedding (wired up via the `RC` env var).
- The root **`.cargo/config.toml`** (gitignored, machine-local) wires it
  up: `rust-lld` as linker, `-Lnative` pointing at the importlibs,
  `stubs.o` + the runtime libs as extra link args, and `CC`/`AR` pointed
  at the zig wrappers. With it in place, `cargo build` / `cargo test`
  work normally from the repo root or `backend/`.

**Warning: `cargo clean` deletes the shim** (it lives under
`backend/target/`). To regenerate it:

1. Re-run `python backend/target/importlibs/gen_import_libs.py` (restore
   that script from your notes/history if it was also deleted) to rebuild
   the `.lib` import libraries from the `.def` files.
2. Rebuild `stubs.o` from `stubs.rs` (same directory):
   `rustc --edition 2021 --crate-type=rlib --emit=obj -C opt-level=2 stubs.rs -o stubs.o`
   (edition 2021 — the file predates edition-2024 unsafe-attribute rules).
   Note: `stubs.rs` also provides `__isnan`/`__isnanf`, which the bundled
   `sqlite3.c` in sqlx's proc-macro DLL needs — a freshly regenerated
   stubs file must include them.
3. Ensure zig is present under `backend/target/tools/` (re-extract
   `zig.zip` there if needed).
4. Regenerate `backend/target/importlibs/legacy_stdio_definitions.lib`
   (rustc MSVC-target default lib; needed for **test** binary linking):
   compile a trivial anchor object with
   `zig cc -target x86_64-windows-gnu -c anchor.c -o anchor.o`, then
   `zig lib -Out:backend/target/importlibs/legacy_stdio_definitions.lib anchor.o`.
5. For the **Tauri desktop build** only: regenerate
   `backend/target/importlibs/uuid.lib`
   (`python gen_import_libs.py . rpcrt4` then copy to `uuid.lib`);
   `cppshim.o` (MSVC C++ runtime stubs — `operator new/delete` (+array
   forms), `std::nothrow`, `/GS` cookie, CFG dispatch, `_Init_thread_*` —
   needed to link the prebuilt `WebView2LoaderStatic.lib` without
   `msvcprt.lib`; build from `cppshim.rs` the same way as `stubs.rs` in
   step 2); and `ucrt.lib`/`libcmt.lib`/`libvcruntime.lib` placeholder
   archives (`zig lib -Out:<name>.lib anchor.o` — `ucrt.lib` also packs
   `ucrtshim.o`, a no-op `atexit`, built from `ucrtshim.rs`), which satisfy
   the loader's `/DEFAULTLIB` directives.

6. The config also passes `--cfg=refthing_link_shim`: it compiles
   `src-tauri`'s `crt_init` (running the CRT initializers this shim skips).
   Normal MSVC builds — every release — leave it out, since their CRT has
   already run them.
7. `stdioshim.o` — a no-op `fprintf` (build from `stdioshim.rs` like
   `stubs.rs`, wired as a link arg in `.cargo/config.toml`). Tauri's
   static-vcruntime link drops `msvcrt.lib`, which supplied `fprintf`;
   libwebp's animation encoder (unused) still references it.

If `cargo build` suddenly fails with `LNK1181`-style "cannot open
kernel32.lib" / missing symbol errors after a clean, this section is why.

## Node.js (via fnm)

Install [fnm](https://github.com/Schniz/fnm) (Fast Node Manager):

```bash
winget install Schniz.fnm
```

Then hook it into Git Bash by adding to `~/.bashrc`:

```bash
eval "$(fnm env --use-on-cd --shell bash)"
```

The repo carries a `.node-version` file; with `--use-on-cd`, fnm switches
automatically when you `cd` into the repo. Node **24+** is required (Node
26 works fine — verified with v26.7.0 / npm 11.19.0).

## Optional but recommended

- **ffmpeg** (with ffprobe): video frame posters and durations (Phase 11),
  and waveforms for the few audio codecs RefThing doesn't decode itself
  (WMA, AC-3, AMR …). Audio waveforms otherwise need nothing: WAV, AIFF,
  CAF, FLAC, MP3, Ogg (Vorbis, Opus), M4A/AAC, ALAC and Matroska/WebM are
  decoded in-process. Without ffmpeg, everything still imports; video just
  draws as a card. If it isn't on `PATH`, point `REFTHING_FFMPEG` /
  `REFTHING_FFPROBE` at the binaries.

  ```powershell
  winget install Gyan.FFmpeg
  ```

- **Blender**: opens `.blend` files on the board (the server converts them
  to GLB headlessly, once per file). GLB, glTF and FBX need nothing. Found
  on `PATH`, in `Program Files\Blender Foundation`, in Steam libraries, or
  at `REFTHING_BLENDER`. Without it a `.blend` draws as a card saying it
  needs Blender.

- **cargo-watch** — backend hot reload during development:

  ```bash
  cargo install cargo-watch
  ```

- **sqlx-cli** — migrations live in `backend/migrations/` and run
  embedded at startup, so the CLI is **not needed to create or apply
  migrations**. It is needed in **Phase 1 wave B** for
  `cargo sqlx prepare` — regenerating the committed offline `.sqlx/`
  query cache that lets CI build with `SQLX_OFFLINE=true` and no live
  database:

  ```bash
  cargo install sqlx-cli --no-default-features --features sqlite
  ```

## Tauri (desktop app)

The desktop app (`src-tauri/`, `npm run dev:app` / `npm run build:app`) needs
two extra pieces:

- **WebView2 Runtime** — preinstalled on Windows 11 and most Windows 10
  machines (this box has it). The Tauri window is a WebView2 control.
- **A Windows resource compiler** — `tauri-build` embeds the app icon and
  version info at compile time via `tauri-winres`, which needs `rc.exe`
  (Windows SDK). On this box the `RC` env var in `.cargo/config.toml`
  points at `backend/target/tools/rc.bat` (a `zig rc` wrapper), so no SDK
  is needed. On a fresh machine with VS Build Tools, `rc.exe` just works.

## Windows Defender / performance

Real-time scanning of build directories makes Rust and npm builds 2-4x
slower on Windows. Either:

- Add **Windows Defender exclusions** for `backend/target` and
  `node_modules` (repo-local and any npm cache), or
- Clone the repo onto a **Dev Drive** (ReFS), which Defender scans
  asynchronously by default.

This single change is the largest build-speed win available on Windows.
