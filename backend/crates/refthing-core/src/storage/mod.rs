//! Content-addressed blob store.
//!
//! Ingest streams bytes to `tmp/<uuidv7>.part` while SHA-256 hashing them in a
//! single pass and sniffing the MIME type with `infer` from the first bytes,
//! then atomically renames the file to `blobs/<hash[0..2]>/<hash[2..4]>/<hash>`.
//! The rename makes ingest crash-safe: a partial blob can never appear at a
//! canonical path, and a leftover `.part` file never affects a later put.
//!
//! Windows quirk: rename-over-existing fails, so a dedup hit (destination
//! already present, identical content by definition) deletes the tmp file and
//! returns the existing blob. `ACCESS_DENIED` from an antivirus holding a lock
//! is retried with a small backoff.

mod layout;

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

const READ_CHUNK: usize = 64 * 1024;
/// `infer` matchers need at most the first few KiB; sniffing stops here.
const SNIFF_LIMIT: usize = 8 * 1024;
const FALLBACK_MIME: &str = "application/octet-stream";
/// Retries for `ACCESS_DENIED` rename failures (antivirus lock), with backoff.
const RENAME_RETRIES: u32 = 5;
const RENAME_BACKOFF_MS: u64 = 50;

/// Result of [`BlobStore::put`]: identity and sniffed metadata of the blob
/// now present at [`BlobStore::path`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobRef {
    /// 64-char lowercase hex SHA-256 of the content.
    pub hash: String,
    pub byte_size: u64,
    /// Sniffed via `infer`, never client-supplied; [`FALLBACK_MIME`] when the
    /// content matches no known signature.
    pub mime: String,
    /// Always `None` in Phase 1 — `infer` reports no dimensions; the `image`
    /// crate fills these in Phase 3.
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Content-addressed blob store rooted at `root` (holds `blobs/` and `tmp/`).
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Returns the canonical path for `hash`, whether or not it exists.
    #[must_use]
    pub fn path(&self, hash: &str) -> PathBuf {
        layout::blob_path(&self.root, hash)
    }

    /// Streams `data` into the store, deduplicating by content hash.
    ///
    /// # Errors
    /// Returns the first I/O error encountered while reading `data`, writing
    /// the tmp file, or renaming it into place; the tmp file is removed on
    /// failure.
    pub async fn put(&self, mut data: impl AsyncRead + Unpin) -> io::Result<BlobRef> {
        let tmp_dir = self.root.join("tmp");
        fs::create_dir_all(&tmp_dir).await?;
        let tmp_path = tmp_dir.join(format!("{}.part", uuid::Uuid::now_v7()));

        let (hash, byte_size, mime) = match stream_to_tmp(&mut data, &tmp_path).await {
            Ok(result) => result,
            Err(error) => {
                let _ = fs::remove_file(&tmp_path).await;
                return Err(error);
            }
        };

        let dest = self.path(&hash);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).await?;
        }
        Self::rename_into_place(&tmp_path, &dest).await?;

        Ok(BlobRef {
            hash,
            byte_size,
            mime,
            width: None,
            height: None,
        })
    }

    /// Opens the blob at `hash` for reading.
    ///
    /// # Errors
    /// Returns [`io::ErrorKind::NotFound`] if no blob exists at `hash`.
    pub async fn open(&self, hash: &str) -> io::Result<fs::File> {
        fs::File::open(self.path(hash)).await
    }

    /// Deletes blob files not in `live` whose last modification is at least
    /// `grace` old, returning the number of files removed. Referenced blobs
    /// are never touched, and young unreferenced blobs survive so an in-flight
    /// insert can still reference them.
    ///
    /// # Errors
    /// Returns the first I/O error encountered while walking or deleting.
    pub async fn gc(&self, live: &HashSet<String>, grace: Duration) -> io::Result<u64> {
        let mut removed = 0;
        let blobs = self.root.join("blobs");
        match fs::metadata(&blobs).await {
            Ok(_) => gc_sweep(&blobs, live, SystemTime::now(), grace, &mut removed).await?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        Ok(removed)
    }

    /// Moves `tmp_path` to `dest`, treating an existing `dest` as a dedup hit
    /// (same hash ⇒ same content ⇒ delete the tmp file). Retries
    /// `ACCESS_DENIED` (antivirus lock) with a small linear backoff.
    async fn rename_into_place(tmp_path: &Path, dest: &Path) -> io::Result<()> {
        if fs::try_exists(dest).await? {
            fs::remove_file(tmp_path).await?;
            return Ok(());
        }
        let mut attempt = 0;
        loop {
            match fs::rename(tmp_path, dest).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    // Windows: rename-over-existing fails; a concurrent put of
                    // the same content may have won the race.
                    if fs::try_exists(dest).await.unwrap_or(false) {
                        fs::remove_file(tmp_path).await?;
                        return Ok(());
                    }
                    if error.kind() == io::ErrorKind::PermissionDenied && attempt < RENAME_RETRIES {
                        attempt += 1;
                        tokio::time::sleep(Duration::from_millis(
                            RENAME_BACKOFF_MS * u64::from(attempt),
                        ))
                        .await;
                    } else {
                        let _ = fs::remove_file(tmp_path).await;
                        return Err(error);
                    }
                }
            }
        }
    }
}

/// Streams `data` to `tmp_path`, hashing every byte in a single pass and
/// sniffing the MIME type from the first [`SNIFF_LIMIT`] bytes.
async fn stream_to_tmp(
    data: &mut (impl AsyncRead + Unpin),
    tmp_path: &Path,
) -> io::Result<(String, u64, String)> {
    let mut file = fs::File::create(tmp_path).await?;
    let mut hasher = Sha256::new();
    let mut sniff = Vec::new();
    let mut mime = None;
    let mut byte_size = 0u64;
    let mut buffer = vec![0u8; READ_CHUNK];
    loop {
        let read = data.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        hasher.update(chunk);
        file.write_all(chunk).await?;
        byte_size += read as u64;
        if mime.is_none() && sniff.len() < SNIFF_LIMIT {
            let take = (SNIFF_LIMIT - sniff.len()).min(chunk.len());
            sniff.extend_from_slice(&chunk[..take]);
            if let Some(kind) = infer::get(&sniff) {
                mime = Some(kind.mime_type().to_string());
            }
        }
    }
    file.flush().await?;
    // On disk before it's renamed into place: a power cut must never leave
    // a complete-looking name over missing bytes.
    file.sync_all().await?;
    drop(file);

    let hash = format!("{:x}", hasher.finalize());
    Ok((
        hash,
        byte_size,
        mime.unwrap_or_else(|| FALLBACK_MIME.to_string()),
    ))
}

/// Recursively deletes unreferenced blob files under `dir` older than `grace`.
async fn gc_sweep(
    dir: &Path,
    live: &HashSet<String>,
    now: SystemTime,
    grace: Duration,
    removed: &mut u64,
) -> io::Result<()> {
    let mut entries = fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let metadata = entry.metadata().await?;
        let path = entry.path();
        if metadata.is_dir() {
            Box::pin(gc_sweep(&path, live, now, grace, removed)).await?;
        } else {
            let name = entry.file_name().to_string_lossy().into_owned();
            if live.contains(&name) {
                continue;
            }
            let age = now
                .duration_since(metadata.modified()?)
                .unwrap_or(Duration::ZERO);
            if age >= grace {
                fs::remove_file(&path).await?;
                *removed += 1;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal valid 1x1 PNG (detected by `infer` as `image/png`).
    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    fn temp_store() -> (tempfile::TempDir, BlobStore) {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = BlobStore::new(dir.path());
        (dir, store)
    }

    async fn read_all(mut file: fs::File) -> Vec<u8> {
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await.expect("read blob");
        bytes
    }

    #[tokio::test]
    async fn put_then_open_round_trips_bytes() {
        let (_dir, store) = temp_store();

        let blob = store.put(PNG_1X1).await.expect("put");
        assert_eq!(blob.byte_size, PNG_1X1.len() as u64);
        assert_eq!(blob.mime, "image/png");
        assert_eq!(blob.hash.len(), 64);
        assert_eq!(blob.width, None);
        assert_eq!(blob.height, None);

        let bytes = read_all(store.open(&blob.hash).await.expect("open")).await;
        assert_eq!(bytes, PNG_1X1);
        assert_eq!(
            store.path(&blob.hash),
            layout::blob_path(&store.root, &blob.hash)
        );
    }

    #[tokio::test]
    async fn put_sniffs_fallback_mime_for_unknown_content() {
        let (_dir, store) = temp_store();
        let blob = store
            .put(&b"definitely not a known format"[..])
            .await
            .expect("put");
        assert_eq!(blob.mime, FALLBACK_MIME);
    }

    #[tokio::test]
    async fn put_dedupes_identical_content() {
        let (_dir, store) = temp_store();

        let first = store.put(PNG_1X1).await.expect("first put");
        let second = store.put(PNG_1X1).await.expect("second put");
        assert_eq!(first, second);

        // Exactly one file in the shard directory, no leftover tmp files.
        let shard = store
            .path(&first.hash)
            .parent()
            .expect("shard dir")
            .to_path_buf();
        let mut entries = fs::read_dir(&shard).await.expect("read shard dir");
        let mut files = 0;
        while entries.next_entry().await.expect("entry").is_some() {
            files += 1;
        }
        assert_eq!(files, 1);

        let mut tmp = fs::read_dir(store.root.join("tmp")).await.expect("tmp dir");
        assert!(tmp.next_entry().await.expect("entry").is_none());
    }

    #[tokio::test]
    async fn shard_path_matches_file_location() {
        let (_dir, store) = temp_store();
        let blob = store.put(PNG_1X1).await.expect("put");
        let expected = store
            .root
            .join("blobs")
            .join(&blob.hash[0..2])
            .join(&blob.hash[2..4])
            .join(&blob.hash);
        assert_eq!(store.path(&blob.hash), expected);
        assert!(fs::try_exists(&expected).await.expect("exists"));
    }

    #[tokio::test]
    async fn leftover_part_file_does_not_affect_put() {
        let (_dir, store) = temp_store();
        let tmp_dir = store.root.join("tmp");
        fs::create_dir_all(&tmp_dir).await.expect("tmp dir");
        let stale = tmp_dir.join("stale.part");
        fs::write(&stale, b"truncated garbage")
            .await
            .expect("seed stale part");

        let blob = store.put(PNG_1X1).await.expect("put");
        let bytes = read_all(store.open(&blob.hash).await.expect("open")).await;
        assert_eq!(bytes, PNG_1X1);
        // The stale scratch file is untouched and harmless.
        assert!(fs::try_exists(&stale).await.expect("exists"));
    }

    #[tokio::test]
    async fn gc_removes_unreferenced_blobs_past_grace() {
        let (_dir, store) = temp_store();
        let keep = store.put(PNG_1X1).await.expect("put referenced");
        let stale = store
            .put(&b"unreferenced content"[..])
            .await
            .expect("put unreferenced");

        let live: HashSet<String> = [keep.hash.clone()].into_iter().collect();
        let removed = store.gc(&live, Duration::ZERO).await.expect("gc");
        assert_eq!(removed, 1);
        assert!(
            fs::try_exists(store.path(&keep.hash))
                .await
                .expect("exists")
        );
        assert!(
            !fs::try_exists(store.path(&stale.hash))
                .await
                .expect("exists")
        );
    }

    #[tokio::test]
    async fn gc_keeps_young_unreferenced_blobs() {
        let (_dir, store) = temp_store();
        let blob = store.put(PNG_1X1).await.expect("put");

        let removed = store
            .gc(&HashSet::new(), Duration::from_secs(3600))
            .await
            .expect("gc");
        assert_eq!(removed, 0);
        assert!(
            fs::try_exists(store.path(&blob.hash))
                .await
                .expect("exists")
        );
    }

    #[tokio::test]
    async fn gc_on_empty_store_removes_nothing() {
        let (_dir, store) = temp_store();
        let removed = store.gc(&HashSet::new(), Duration::ZERO).await.expect("gc");
        assert_eq!(removed, 0);
    }

    #[tokio::test]
    async fn open_missing_blob_is_not_found() {
        let (_dir, store) = temp_store();
        let error = store.open(&"0".repeat(64)).await.expect_err("open fails");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
    }
}
