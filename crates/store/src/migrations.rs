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
];

pub const LATEST_VERSION: i64 = MIGRATIONS.len() as i64;

pub fn migrate(conn: &mut Connection) -> Result<i64, StoreError> {
    let current: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if current > LATEST_VERSION {
        return Err(StoreError::NewerSchema {
            found: current,
            supported: LATEST_VERSION,
        });
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let version = index as i64 + 1;
        let tx = conn.transaction()?;
        tx.execute_batch(sql)
            .map_err(|source| StoreError::Migration { version, source })?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(LATEST_VERSION)
}
