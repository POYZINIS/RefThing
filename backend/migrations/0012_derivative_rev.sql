-- Which revision of its renderer made a derivative (0: the image pyramid,
-- and ffmpeg's old audio waveforms). Audio posters drawn by an older
-- waveform renderer are redrawn at startup, and the revision is part of a
-- poster's URL (`?v=`), so a cached copy of the old one never shows.

ALTER TABLE blob_derivatives ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
