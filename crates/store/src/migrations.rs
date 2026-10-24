//! Forward-only schema migrations, tracked with SQLite's `user_version`.

use rusqlite::Connection;

use crate::StoreError;

/// Migration N (1-based) upgrades a database at `user_version = N - 1` to `N`. Never edit a shipped
/// entry; append a new one instead.
const MIGRATIONS: &[&str] = &[
    // 1: settings + workspace state (ADR-0004).
    "CREATE TABLE settings (
         key        TEXT PRIMARY KEY NOT NULL,
         value_json TEXT NOT NULL,
         updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ) STRICT;
     CREATE TABLE workspace_state (
         key        TEXT PRIMARY KEY NOT NULL,
         value_json TEXT NOT NULL,
         updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ) STRICT;",
    // 2: connection profiles (M2.1). No secret columns, by design (ADR-0003).
    "CREATE TABLE connections (
         id                   TEXT PRIMARY KEY NOT NULL,
         name                 TEXT NOT NULL,
         engine               TEXT NOT NULL,
         host                 TEXT NOT NULL,
         port                 INTEGER NOT NULL,
         database             TEXT NOT NULL,
         username             TEXT NOT NULL,
         ssl_mode             TEXT NOT NULL,
         connect_timeout_secs INTEGER NOT NULL,
         read_only            INTEGER NOT NULL,
         environment          TEXT NOT NULL,
         color                TEXT,
         save_mode            TEXT NOT NULL,
         password_saved       INTEGER NOT NULL DEFAULT 0,
         created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ) STRICT;
     CREATE UNIQUE INDEX connections_name_unique ON connections (name COLLATE NOCASE);",
    // 3: default transaction mode and isolation per data source (M4.6).
    "ALTER TABLE connections ADD COLUMN tx_mode TEXT NOT NULL DEFAULT 'auto';
     ALTER TABLE connections ADD COLUMN isolation TEXT NOT NULL DEFAULT 'read_committed';",
    // 4: query history with full-text search on the statement text (M5.1, ADR-0004).
    "ALTER TABLE connections ADD COLUMN history_enabled INTEGER NOT NULL DEFAULT 1;
     CREATE TABLE query_history (
         id            INTEGER PRIMARY KEY,
         connection_id TEXT NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
         console       TEXT,
         sql           TEXT NOT NULL,
         started_at    INTEGER NOT NULL,
         duration_ms   INTEGER NOT NULL,
         status        TEXT NOT NULL,
         row_count     INTEGER,
         error         TEXT,
         tx_mode       TEXT NOT NULL
     ) STRICT;
     CREATE INDEX query_history_by_connection ON query_history (connection_id, id);
     CREATE INDEX query_history_by_time ON query_history (started_at);
     CREATE VIRTUAL TABLE query_history_fts USING fts5 (
         sql, content = 'query_history', content_rowid = 'id', tokenize = 'unicode61'
     );
     CREATE TRIGGER query_history_ai AFTER INSERT ON query_history BEGIN
         INSERT INTO query_history_fts (rowid, sql) VALUES (new.id, new.sql);
     END;
     CREATE TRIGGER query_history_ad AFTER DELETE ON query_history BEGIN
         INSERT INTO query_history_fts (query_history_fts, rowid, sql)
         VALUES ('delete', old.id, old.sql);
     END;",
    // 5: folders and ordering, SSH profiles and trusted host keys, TLS files, connection options
    // and schema scope (M4.9). Secrets stay in the keyring (ADR-0003); only flags live here.
    "CREATE TABLE folders (
         id         TEXT PRIMARY KEY NOT NULL,
         name       TEXT NOT NULL,
         color      TEXT,
         sort_order INTEGER NOT NULL DEFAULT 0
     ) STRICT;
     CREATE UNIQUE INDEX folders_name_unique ON folders (name COLLATE NOCASE);
     CREATE TABLE ssh_profiles (
         id           TEXT PRIMARY KEY NOT NULL,
         name         TEXT NOT NULL,
         host         TEXT NOT NULL,
         port         INTEGER NOT NULL,
         username     TEXT NOT NULL,
         auth         TEXT NOT NULL,
         key_file     TEXT,
         save_mode    TEXT NOT NULL,
         secret_saved INTEGER NOT NULL DEFAULT 0,
         created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ) STRICT;
     CREATE UNIQUE INDEX ssh_profiles_name_unique ON ssh_profiles (name COLLATE NOCASE);
     CREATE TABLE ssh_known_hosts (
         host        TEXT NOT NULL,
         port        INTEGER NOT NULL,
         algorithm   TEXT NOT NULL,
         fingerprint TEXT NOT NULL,
         trusted_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         PRIMARY KEY (host, port)
     ) STRICT;
     ALTER TABLE connections ADD COLUMN folder_id TEXT REFERENCES folders (id) ON DELETE SET NULL;
     ALTER TABLE connections ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE connections ADD COLUMN ssh_profile_id TEXT REFERENCES ssh_profiles (id);
     ALTER TABLE connections ADD COLUMN tls_ca_file TEXT;
     ALTER TABLE connections ADD COLUMN tls_cert_file TEXT;
     ALTER TABLE connections ADD COLUMN tls_key_file TEXT;
     ALTER TABLE connections ADD COLUMN keepalive_secs INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE connections ADD COLUMN auto_disconnect_mins INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE connections ADD COLUMN startup_sql TEXT NOT NULL DEFAULT '';
     ALTER TABLE connections ADD COLUMN schema_names TEXT NOT NULL DEFAULT '[]';
     ALTER TABLE connections ADD COLUMN schema_pattern TEXT NOT NULL DEFAULT '';
     ALTER TABLE connections ADD COLUMN url_only INTEGER NOT NULL DEFAULT 0;",
    // 6: local history of console files (M5.2). Keyed by console name; renames move them.
    "CREATE TABLE console_revisions (
         id         INTEGER PRIMARY KEY,
         console    TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         reason     TEXT NOT NULL,
         text       TEXT NOT NULL,
         size       INTEGER NOT NULL
     ) STRICT;
     CREATE INDEX console_revisions_by_console ON console_revisions (console, id);
     CREATE INDEX console_revisions_by_time ON console_revisions (created_at);",
];

pub const LATEST_VERSION: i64 = MIGRATIONS.len() as i64;

pub fn migrate(conn: &mut Connection) -> Result<i64, StoreError> {
    migrate_to(conn, LATEST_VERSION)
}

/// Applies migrations up to `target` (tests build databases of older versions with this).
pub(crate) fn migrate_to(conn: &mut Connection, target: i64) -> Result<i64, StoreError> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current > LATEST_VERSION {
        return Err(StoreError::NewerSchema {
            found: current,
            supported: LATEST_VERSION,
        });
    }
    for (index, sql) in MIGRATIONS
        .iter()
        .enumerate()
        .take(target as usize)
        .skip(current as usize)
    {
        let version = index as i64 + 1;
        let tx = conn.transaction()?;
        tx.execute_batch(sql)
            .map_err(|source| StoreError::Migration { version, source })?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(target.max(current))
}
