//! SQLite pool construction, pragmas, and embedded migrations.
//!
//! WAL gives many readers but a single writer, so [`connect`] returns two
//! pools: all mutating calls must go through [`Pools::write`]
//! (`max_connections(1)`), reads through [`Pools::read`]. Skipping this is the
//! classic `SQLITE_BUSY`-despite-`busy_timeout` failure under bulk ingest.

pub mod blobs;
pub mod boards;
pub mod groups;
pub mod items;
pub mod notes;
pub mod tags;
pub mod views;

use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha384};
use sqlx::migrate::Migrator;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::{SqlitePool, migrate};

use crate::error::CoreError;

const MAX_READ_CONNECTIONS: u32 = 8;

/// How often the WAL checkpoint background task runs.
const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(60);

/// Read/write connection pools enforcing SQLite's single-writer discipline.
#[derive(Debug, Clone)]
pub struct Pools {
    pub read: SqlitePool,
    pub write: SqlitePool,
}

/// Spawns a background task that periodically runs `PRAGMA wal_checkpoint`,
/// keeping the WAL file bounded. `wal_autocheckpoint` already fires at
/// 1000 pages, but an ongoing stream of small writes may keep the WAL from
/// ever hitting the threshold on a quiet board — this guarantees a bounded
/// WAL regardless of write pattern.
///
/// The loop is a passive checkpoint (`WAL_CHECKPOINT_PASSIVE`), which never
/// blocks readers/writers and simply flushes committed frames when it can.
/// The task aborts when the write pool is closed (server shutdown).
#[must_use]
pub fn spawn_checkpoint_task(pools: Pools) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(CHECKPOINT_INTERVAL);
        loop {
            interval.tick().await;
            let _ = sqlx::query("PRAGMA wal_checkpoint(PASSIVE)")
                .execute(&pools.write)
                .await;
        }
    })
}

/// Opens (creating if needed) the database at `path`, applies all embedded
/// migrations from `backend/migrations/`, and returns the read/write pools.
///
/// # Errors
/// Returns [`CoreError::Db`] if the database cannot be opened or a migration
/// fails.
pub async fn connect(path: &Path) -> Result<Pools, CoreError> {
    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        // FULL: every commit is on disk before it returns. WAL's NORMAL can
        // lose the last commits to a power cut; with no save button, an
        // edit the app showed as done must survive one.
        .synchronous(SqliteSynchronous::Full)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true);

    let write = open_pool(&options, 1).await?;
    // Migrations run on the single-connection write pool; the schema is
    // current before any reader connects.
    let migrator = migrate!("../../migrations");
    reconcile_line_endings(&write, &migrator).await?;
    migrator
        .run(&write)
        .await
        .map_err(|error| CoreError::Db(error.to_string()))?;
    let read = open_pool(&options, MAX_READ_CONNECTIONS).await?;

    Ok(Pools { read, write })
}

/// sqlx checksums a migration's raw bytes, so the same SQL checked out with
/// the other line endings (a Windows checkout before `.gitattributes` fixed
/// them to LF) reads as "modified" and the server refuses to start. Line
/// endings aren't content: where a recorded checksum matches this
/// migration's SQL with CRLF and LF swapped, record the current checksum.
/// Any other mismatch is left for the migrator to report.
async fn reconcile_line_endings(pool: &SqlitePool, migrator: &Migrator) -> Result<(), CoreError> {
    let db = |error: sqlx::Error| CoreError::Db(error.to_string());
    let (exists,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'",
    )
    .fetch_one(pool)
    .await
    .map_err(db)?;
    if exists == 0 {
        return Ok(());
    }
    let applied: Vec<(i64, Vec<u8>)> =
        sqlx::query_as("SELECT version, checksum FROM _sqlx_migrations")
            .fetch_all(pool)
            .await
            .map_err(db)?;
    for migration in migrator.iter() {
        let Some((_, recorded)) = applied
            .iter()
            .find(|(version, _)| *version == migration.version)
        else {
            continue;
        };
        if recorded.as_slice() == migration.checksum.as_ref() {
            continue;
        }
        let lf = migration.sql.replace("\r\n", "\n");
        let crlf = lf.replace('\n', "\r\n");
        let same = [lf, crlf]
            .iter()
            .any(|sql| Sha384::digest(sql.as_bytes()).as_slice() == recorded.as_slice());
        if same {
            sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
                .bind(migration.checksum.as_ref())
                .bind(migration.version)
                .execute(pool)
                .await
                .map_err(db)?;
        }
    }
    Ok(())
}

async fn open_pool(
    options: &SqliteConnectOptions,
    max_connections: u32,
) -> Result<SqlitePool, CoreError> {
    SqlitePoolOptions::new()
        .max_connections(max_connections)
        .after_connect(|connection, _meta| {
            Box::pin(async move {
                sqlx::query(
                    "PRAGMA wal_autocheckpoint = 1000;\
                     PRAGMA temp_store = MEMORY;\
                     PRAGMA mmap_size = 268435456;",
                )
                .execute(connection)
                .await?;
                Ok(())
            })
        })
        .connect_with(options.clone())
        .await
        .map_err(|error| CoreError::Db(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn temp_pools() -> (tempfile::TempDir, Pools) {
        let dir = tempfile::tempdir().expect("temp dir");
        let pools = connect(&dir.path().join("test.db")).await.expect("connect");
        (dir, pools)
    }

    #[tokio::test]
    async fn fresh_db_uses_wal_and_foreign_keys() {
        let (_dir, pools) = temp_pools().await;

        let (journal_mode,): (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&pools.read)
            .await
            .expect("journal_mode pragma");
        assert_eq!(journal_mode, "wal");

        let (foreign_keys,): (i64,) = sqlx::query_as("PRAGMA foreign_keys")
            .fetch_one(&pools.read)
            .await
            .expect("foreign_keys pragma");
        assert_eq!(foreign_keys, 1);
    }

    #[tokio::test]
    async fn write_pool_is_single_connection() {
        let (_dir, pools) = temp_pools().await;
        assert_eq!(pools.write.options().get_max_connections(), 1);
        assert_eq!(pools.read.options().get_max_connections(), 8);
    }

    #[tokio::test]
    async fn migrations_apply_cleanly_twice() {
        let (_dir, pools) = temp_pools().await;
        migrate!("../../migrations")
            .run(&pools.write)
            .await
            .expect("migrations are idempotent");
    }

    #[tokio::test]
    async fn line_ending_only_changes_are_not_modified_migrations() {
        let (dir, pools) = temp_pools().await;
        // Record migration 1 as though it had been applied from a CRLF
        // checkout, and another as though its SQL had really changed.
        let migrator = migrate!("../../migrations");
        let first = migrator.iter().next().expect("a migration");
        let crlf = first.sql.replace("\r\n", "\n").replace('\n', "\r\n");
        let crlf_sum = Sha384::digest(crlf.as_bytes()).to_vec();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
            .bind(&crlf_sum)
            .bind(first.version)
            .execute(&pools.write)
            .await
            .expect("fake a CRLF checksum");
        pools.write.close().await;
        pools.read.close().await;
        connect(&dir.path().join("test.db"))
            .await
            .expect("a line-ending difference is not a modified migration");

        let pools = connect(&dir.path().join("test.db"))
            .await
            .expect("reconnect");
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
            .bind(vec![0_u8; 48])
            .bind(first.version)
            .execute(&pools.write)
            .await
            .expect("fake a real edit");
        pools.write.close().await;
        pools.read.close().await;
        assert!(
            connect(&dir.path().join("test.db")).await.is_err(),
            "a real edit still fails"
        );
    }

    #[tokio::test]
    async fn touch_trigger_updates_updated_at() {
        let (_dir, pools) = temp_pools().await;
        let board_id = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO boards (id, name) VALUES (?, 'board')")
            .bind(&board_id)
            .execute(&pools.write)
            .await
            .expect("insert board");
        let item_id = uuid::Uuid::now_v7().to_string();
        sqlx::query(
            "INSERT INTO items (id, board_id, type, width, height) \
             VALUES (?, ?, 'image', 100.0, 100.0)",
        )
        .bind(&item_id)
        .bind(&board_id)
        .execute(&pools.write)
        .await
        .expect("insert item");

        // Backdating updated_at in the same statement proves the AFTER UPDATE
        // trigger overwrites it with the current timestamp.
        sqlx::query(
            "UPDATE items SET x = 1.0, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
        )
        .bind(&item_id)
        .execute(&pools.write)
        .await
        .expect("update item");

        let (updated_at,): (String,) = sqlx::query_as("SELECT updated_at FROM items WHERE id = ?")
            .bind(&item_id)
            .fetch_one(&pools.read)
            .await
            .expect("select updated_at");
        assert_ne!(updated_at, "2000-01-01T00:00:00.000Z");
    }
}
