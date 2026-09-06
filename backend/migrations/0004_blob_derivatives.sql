-- RefThing Phase 3: image pyramid derivatives.
--
-- One row per (blob, level). Levels below the original's longest edge are
-- generated WebP files under `deriv/`; levels at or above it alias the
-- original bytes (`full` always does). `status` tracks the pipeline:
-- pending (job enqueued) -> ready | failed (permanent after retries).

CREATE TABLE blob_derivatives (
    blob_hash TEXT NOT NULL,
    level     TEXT NOT NULL CHECK (level IN ('thumb', 'small', 'medium', 'full')),
    width     INTEGER NOT NULL,
    height    INTEGER NOT NULL,
    byte_size INTEGER NOT NULL,
    format    TEXT NOT NULL, -- 'image/webp' for derived levels, original mime for 'full'/aliases
    status    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
    PRIMARY KEY (blob_hash, level)
);
