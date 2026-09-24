-- Locked groups (interaction conventions §6 RULE 3).
--
-- A locked group cannot be moved, resized, rotated or flipped at the group
-- level; the only group-level interaction left is double-click to drill into
-- a child. Locking never alters the group's members. Existing groups start
-- unlocked, which matches how they behaved before this migration.

ALTER TABLE groups ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
