# Releasing RefThing

Releases are built by GitHub Actions (`.github/workflows/release.yml`) on a
clean Windows runner — not on a dev machine, so the no-MSVC link shim
(`docs/prerequisites.md`) never touches a release.

## Cutting a release

1. Bump the version in **`src-tauri/tauri.conf.json`** (the app's version —
   what the updater compares) and, to keep them in step,
   `src-tauri/Cargo.toml`.
2. Commit to `main` and push.
3. Tag and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

The workflow checks the tag matches the version, builds the NSIS installer
(per-user install, no admin), signs the update package, and publishes the
release with:

- `RefThing_<version>_x64-setup.exe` — the installer people download;
- `RefThing_<version>_x64-setup.exe.sig` — its update signature;
- `latest.json` — what installed copies read to find updates.

## Updates

Installed copies check
`https://github.com/POYZINIS/RefThing/releases/latest/download/latest.json`
a few seconds after starting (quietly — offline is fine) and from
**Settings → Updates**. A newer version shows a toast; installing waits for
the user, downloads the installer, checks its signature against the public
key in `tauri.conf.json` (`plugins.updater.pubkey`), and runs it. The repo
must be public for this URL to work.

## The signing key

Updates are signed with a private key that is **not** in the repo:

- on the maintainer's machine: `%USERPROFILE%\.tauri\refthing-updater.key`
  (no password; `.pub` beside it);
- in the repo's Actions secrets: `TAURI_SIGNING_PRIVATE_KEY` (the key
  file's contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty).

**Back the key up.** If it's lost, installed copies can never be updated
again — they only accept updates signed by it (a new key means people
reinstall by hand).

## Not yet

- The installer isn't Authenticode code-signed, so Windows SmartScreen
  warns on first run ("More info → Run anyway"). Fixing that needs a code
  signing certificate.
