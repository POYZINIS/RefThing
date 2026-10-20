# Security

## Reporting a problem

Please report security issues privately through GitHub's
**Security → Report a vulnerability** on this repository rather than in a
public issue.

## How RefThing protects your boards

- **Local only.** The server listens on `127.0.0.1` and answers only
  RefThing's own pages and local programs. A request from another website
  (by its `Origin`) or reaching the server under a foreign host name (DNS
  rebinding) is refused, and no CORS headers are sent, so a web page open in
  your browser can't read or change your boards
  (`backend/crates/refthing-server/src/local_only.rs`).
- **Dropped files can't act as the app.** Files that a browser could run as
  a page (HTML, SVG, XML, scripts) are served with a sandboxing
  `Content-Security-Policy` and `nosniff`: no scripts, no access to the API.
- **Untrusted board files.** Imported `.ref` / archive files are checked
  before anything is written: every blob against its SHA-256, preview file
  names against a strict allow-list (no paths), and references between
  records.
- **Opening a file from a board** (desktop) hands the system a copy under
  its own name, in the app's data folder; the window may open nothing else.
  Programs and scripts (`.exe`, `.bat`, `.ps1`, `.js`, `.lnk`, …) are never
  opened this way — a board from someone else could carry `cute.pdf.exe` —
  and stay downloadable.
- **`.blend` files** are converted by Blender with `--factory-startup
  --disable-autoexec`, so scripts embedded in a file never run.
- **Updates** are downloaded over HTTPS from this repository's releases
  and installed only if their signature matches the public key built into
  the app.

## Known limits

- The `.ref` file encryption key ships inside the app: it keeps board files
  opaque to other programs, not secret from someone determined.
- Media is decoded by your installed FFmpeg and Blender (when present);
  keep them up to date.
- The Windows installer isn't Authenticode code-signed yet.
