# Step 09: Query history

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Milestone    | M5.1                               |
| Status       | Done                               |
| Depends on   | 03                                 |
| Requirements | REQ-HIST-01, REQ-HIST-02; ADR-0004 |
| Started      | 2026-10-23                         |
| Finished     | 2026-10-23                         |

## Goal

Every statement a user runs is recorded per connection and can be found again with full-text
search, unless the user has turned history off for that connection.

## Scope

- `query_history` table with FTS5 search in `app.db`.
- Recording from the backend for every run (success, error, cancel).
- History popup: search, insert into editor, delete.
- Retention (count and age), per-connection disable, export.

## Out of scope

- Redacting literals in history (planned "Later" in ADR-0004).
- Execution log of internal metadata queries (REQ-HIST-04, Later).

## Design notes

- **Recording**: in `src-tauri/src/exec.rs` after each statement finishes, not from the UI, so the
  record is complete even if the UI crashes. Fields: connection id, session key, statement text,
  started at, duration, status, rows affected or returned, error summary, transaction mode.
- **Storage**: `crates/store` migration adds `query_history` and an FTS5 table on `sql`. Writes go
  through the store's blocking thread; batch inserts if a script has many statements.
- **Verify** that the bundled SQLite in `rusqlite` has FTS5 enabled; if not, enable it with the
  appropriate feature.
- **Retention**: default 10,000 per connection (ADR-0004), plus an optional age limit; pruning runs
  after inserts in batches.
- **Disable**: a per-connection flag (migration on `connections`), checked before recording.

## Tasks

### Backend

- [x] Confirm FTS5 in the bundled SQLite.
- [x] Store migration: `query_history`, FTS5 index, `history_enabled` on `connections`.
- [x] Record each statement from the exec job.
- [x] `history_search(query)` (data source, text, limit, offset), `history_delete(ids)`,
      `history_clear(connection_id)`, `history_export(query, format)` (Rust-side save dialog).
- [x] Retention pruning (count and age), with settings.

### IPC

- [x] Commands above; capabilities and bindings.

### Frontend

- [x] History popup (Ctrl+Alt+E default) with search box, connection filter, status icons,
      duration.
- [x] Insert into editor (at caret) and open in new console.
- [x] Delete entry and clear for a connection, with confirmation.
- [x] Connection dialog: "Record query history" checkbox.
- [x] Settings: retention count and age.

### Tests

- [x] Store: migration on empty and upgraded databases.
- [x] Integration: success, error and cancelled runs are all recorded with the right status.
- [x] A connection with history disabled writes no rows (test asserts on the table).
- [x] Retention prunes oldest first at the limit.
- [x] FTS search finds by table name and keyword.

### Docs

- [x] Mark M5.1 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [x] History records every run, including failures and cancels.
- [x] Disabling history for a connection writes nothing for it.
- [x] Search over 10,000 entries returns in under 100 ms.

## Risks and open questions

- History contains literals, which may be sensitive. The disable flag is the MVP answer; redaction
  is Later. State this in the connection dialog's help text.

## Progress log

| Date       | Note                                                                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-23 | Bundled SQLite has FTS5 (`sqlite_compileoption_used('ENABLE_FTS5')`, tested); no feature flag needed.                                                                                                                                                          |
| 2026-10-23 | Records are written in one batch after the run ends (not per statement), in the same transaction as pruning. The job loop moved into `run_statements`, which needs no `AppHandle`, so the integration test drives the real loop against the disposable server. |
| 2026-10-23 | `started_at` is Unix milliseconds (no date crate); export formats it as ISO 8601 UTC. History rows reference `connections` with `ON DELETE CASCADE`, so deleting a data source removes its history.                                                            |
| 2026-10-23 | Search quotes every word as a prefix phrase (`"word"*`), so user input never reaches FTS syntax; words without letters or digits are ignored.                                                                                                                  |
| 2026-10-23 | Export writes CSV or JSON through the `quarry-io` writer; the popup offers both. Retention: 100 to 1,000,000 entries, age 0 (off) to 3,650 days; saving smaller limits prunes at once.                                                                         |
| 2026-10-23 | E2E: run with one worker on this laptop; with default parallelism WebKit timed out from load (every test passes serially).                                                                                                                                     |
