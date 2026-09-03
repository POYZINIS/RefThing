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

- **cargo-watch** — backend hot reload during development:

  ```bash
  cargo install cargo-watch
  ```

- **sqlx-cli** (needed from Phase 1 onward for migrations):

  ```bash
  cargo install sqlx-cli --no-default-features --features sqlite
  ```

## Windows Defender / performance

Real-time scanning of build directories makes Rust and npm builds 2-4x
slower on Windows. Either:

- Add **Windows Defender exclusions** for `backend/target` and
  `node_modules` (repo-local and any npm cache), or
- Clone the repo onto a **Dev Drive** (ReFS), which Defender scans
  asynchronously by default.

This single change is the largest build-speed win available on Windows.
