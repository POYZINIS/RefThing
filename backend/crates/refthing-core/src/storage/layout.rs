//! Hash → on-disk path mapping for the content-addressed blob store.

use std::path::{Path, PathBuf};

/// Returns the canonical path for `hash`:
/// `root/blobs/<hash[0..2]>/<hash[2..4]>/<hash>` (no extension).
///
/// Two-level prefix sharding keeps ≤~65k files per directory worst case,
/// which plays nice with NTFS and antivirus scanners. A hash shorter than
/// 4 characters (only possible for caller-supplied garbage) lands directly
/// under `blobs/` instead of panicking on the slice.
#[must_use]
pub fn blob_path(root: &Path, hash: &str) -> PathBuf {
    let mut path = root.join("blobs");
    if let (Some(first), Some(second)) = (hash.get(0..2), hash.get(2..4)) {
        path = path.join(first).join(second);
    }
    path.join(hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shards_on_two_level_prefix() {
        let hash = "abcdef0123456789".repeat(4);
        assert_eq!(
            blob_path(Path::new("root"), &hash),
            Path::new("root")
                .join("blobs")
                .join("ab")
                .join("cd")
                .join(&hash)
        );
    }

    #[test]
    fn short_hash_falls_back_to_unsharded() {
        assert_eq!(
            blob_path(Path::new("root"), "ab"),
            Path::new("root").join("blobs").join("ab")
        );
    }
}
