//! The `.ref` file's encryption layer: a small header, then a board archive
//! (the same zip as `*.refthing.zip`) run through AES-128 in counter mode.
//!
//! ```text
//! 0..8    magic   b"REFBOARD"
//! 8..10   version u16 LE (1)
//! 10..12  reserved (0)
//! 12..28  IV      16 random bytes, fresh for every write
//! 28..    AES-128-CTR(archive)
//! ```
//!
//! CTR is a stream cipher with random access: any byte can be decrypted
//! from its own offset, so [`CryptFile`] hands the zip reader and writer an
//! ordinary `Read`/`Write` + `Seek` view of the plaintext — no temp copy,
//! and AES runs on the CPU's AES instructions (gigabytes per second), far
//! faster than the disk. The key ships inside the app: this keeps the
//! contents opaque to anything that isn't `RefThing` and catches no-one
//! determined, and there is no password to lose.

use std::io::{self, Read, Seek, SeekFrom, Write};

use aes::Aes128;
use ctr::cipher::{KeyIvInit, StreamCipher, StreamCipherSeek};

type Cipher = ctr::Ctr128BE<Aes128>;

pub const REF_MAGIC: &[u8; 8] = b"REFBOARD";
pub const REF_VERSION: u16 = 1;
/// Bytes before the encrypted archive.
pub const HEADER_LEN: u64 = 28;
const KEY: [u8; 16] = *b"RefThing.board.1";

/// A `.ref` file's contents as plaintext: reads decrypt, writes encrypt,
/// seeks move within the archive (header excluded).
pub struct CryptFile<F> {
    inner: F,
    cipher: Cipher,
    /// Plaintext position (the file position minus the header).
    position: u64,
    scratch: Vec<u8>,
}

impl<F: Write + Seek> CryptFile<F> {
    /// Starts a new `.ref` file on `inner` (at its start): writes the
    /// header with a fresh IV.
    ///
    /// # Errors
    /// Returns the underlying I/O error.
    pub fn create(mut inner: F, iv: [u8; 16]) -> io::Result<Self> {
        inner.seek(SeekFrom::Start(0))?;
        inner.write_all(REF_MAGIC)?;
        inner.write_all(&REF_VERSION.to_le_bytes())?;
        inner.write_all(&[0, 0])?;
        inner.write_all(&iv)?;
        Ok(Self::with_iv(inner, iv))
    }
}

impl<F: Read + Seek> CryptFile<F> {
    /// Opens a `.ref` file on `inner`: checks the header and takes its IV.
    ///
    /// # Errors
    /// [`io::ErrorKind::InvalidData`] when it isn't a `.ref` file or is from
    /// a newer version; otherwise the underlying I/O error.
    pub fn open(mut inner: F) -> io::Result<Self> {
        let mut header = [0u8; 28];
        inner.seek(SeekFrom::Start(0))?;
        inner
            .read_exact(&mut header)
            .map_err(|_| not_ref("too short"))?;
        if &header[..8] != REF_MAGIC {
            return Err(not_ref("not a RefThing board file"));
        }
        let version = u16::from_le_bytes([header[8], header[9]]);
        if version > REF_VERSION {
            return Err(not_ref(&format!(
                "made by a newer RefThing (file version {version})"
            )));
        }
        let mut iv = [0u8; 16];
        iv.copy_from_slice(&header[12..28]);
        Ok(Self::with_iv(inner, iv))
    }
}

/// Whether `bytes` (a file's start) is a `.ref` file.
#[must_use]
pub fn is_ref(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && &bytes[..8] == REF_MAGIC
}

fn not_ref(reason: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason.to_string())
}

impl<F> CryptFile<F> {
    fn with_iv(inner: F, iv: [u8; 16]) -> Self {
        Self {
            inner,
            cipher: Cipher::new(&KEY.into(), &iv.into()),
            position: 0,
            scratch: Vec::new(),
        }
    }

    /// The underlying file (to flush / sync it once written).
    pub fn into_inner(self) -> F {
        self.inner
    }

    fn apply(&mut self, data: &mut [u8]) {
        self.cipher.seek(self.position);
        self.cipher.apply_keystream(data);
    }
}

impl<F: Read> Read for CryptFile<F> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.apply(&mut buf[..read]);
        self.position += read as u64;
        Ok(read)
    }
}

impl<F: Write> Write for CryptFile<F> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut scratch = std::mem::take(&mut self.scratch);
        scratch.clear();
        scratch.extend_from_slice(buf);
        self.apply(&mut scratch);
        let result = self.inner.write_all(&scratch);
        self.scratch = scratch;
        result?;
        self.position += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl<F: Seek> Seek for CryptFile<F> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let file_position = match to {
            SeekFrom::Start(offset) => self.inner.seek(SeekFrom::Start(HEADER_LEN + offset))?,
            other => self.inner.seek(other)?,
        };
        if file_position < HEADER_LEN {
            // Never into the header: put the file back where it was.
            self.inner
                .seek(SeekFrom::Start(HEADER_LEN + self.position))?;
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before the start of the archive",
            ));
        }
        self.position = file_position - HEADER_LEN;
        Ok(self.position)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn round_trips_with_random_access_and_hides_the_bytes() {
        let plain: Vec<u8> = (0..100_000u32).map(|n| (n % 251) as u8).collect();
        let mut file = CryptFile::create(Cursor::new(Vec::new()), [7; 16]).expect("create");
        file.write_all(&plain).expect("write");
        // Rewrite a stretch in the middle (as zip does for its headers).
        file.seek(SeekFrom::Start(5_000)).expect("seek");
        file.write_all(&plain[5_000..5_100]).expect("rewrite");
        let bytes = file.into_inner().into_inner();
        assert!(is_ref(&bytes));
        assert_eq!(bytes.len() as u64, HEADER_LEN + plain.len() as u64);
        assert_ne!(
            &bytes[usize::try_from(HEADER_LEN).expect("small")..][..64],
            &plain[..64],
            "encrypted"
        );

        let mut reader = CryptFile::open(Cursor::new(bytes)).expect("open");
        let mut all = Vec::new();
        reader.read_to_end(&mut all).expect("read");
        assert_eq!(all, plain);
        // Random access from the end, as zip reads its directory.
        let at = reader.seek(SeekFrom::End(-10)).expect("seek from end");
        assert_eq!(at, plain.len() as u64 - 10);
        let mut tail = [0u8; 10];
        reader.read_exact(&mut tail).expect("read tail");
        assert_eq!(&tail, &plain[plain.len() - 10..]);
    }

    #[test]
    fn other_files_are_refused() {
        assert!(CryptFile::open(Cursor::new(b"PK\x03\x04 a zip".to_vec())).is_err());
        let mut newer = Vec::from(*REF_MAGIC);
        newer.extend_from_slice(&99u16.to_le_bytes());
        newer.extend_from_slice(&[0; 18]);
        assert!(CryptFile::open(Cursor::new(newer)).is_err());
    }
}
