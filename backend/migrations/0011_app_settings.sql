-- App-wide settings the server needs (key → value). First key:
-- `boards_folder`, where new boards are kept as `.ref` files (Settings →
-- Board files); unset, the app's default (the user's Documents folder).

CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
