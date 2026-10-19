# ADR-0004 — Local application storage

- Status: **Accepted** (2026-10-19)

## Decision

- One SQLite file, `app.db`, in the OS app-data directory (Tauri `app_data_dir`), accessed **only from
  Rust** via `rusqlite` (bundled SQLite) on a dedicated blocking thread.
  - We deliberately **do not** use `tauri-plugin-sql`, which would let the WebView run arbitrary SQL
    against app storage.
- Versioned, forward-only migrations are embedded in the binary and run at startup inside a transaction.
- Tables (initial):
  - `connections` (id, name, engine, host, port, database, user, options_json, environment, color,
    read_only, secret_ref, save_mode, created_at, updated_at)
  - `folders`
  - `query_history` (id, connection_id, sql, started_at, duration_ms, row_count, status, error_summary;
    FTS5 index on `sql`)
  - `snippets`
  - `settings` (key, json)
  - `workspace_state` (open tabs, layout, selected connection)
  - `ai_consents` (connection_id, scope, grant, granted_at)
- **Consoles and saved SQL files are plain `.sql` files** on disk (`<app_data>/consoles/<connection-id>/…`
  and user-chosen paths), not DB rows. This matches the observed DataGrip approach (00-methodology, E3)
  and keeps user SQL greppable and VCS-friendly. `workspace_state` references them by path.
- History retention defaults to 10,000 entries per connection, configurable.
  - History can be disabled per connection, e.g. for sensitive production environments.
  - Literal values are stored as typed. A "redact literals in history" option is planned (Later).

## Consequences

- The frontend gets typed commands (`history_search`, `settings_get/set`, …), not a database handle.
- Backup = copy `app.db` plus the consoles directory. Neither contains secrets.
