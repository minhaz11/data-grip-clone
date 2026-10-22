# Step 09: Query history

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Milestone    | M5.1                               |
| Status       | Not started                        |
| Depends on   | 03                                 |
| Requirements | REQ-HIST-01, REQ-HIST-02; ADR-0004 |
| Started      | -                                  |
| Finished     | -                                  |

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

- [ ] Confirm FTS5 in the bundled SQLite.
- [ ] Store migration: `query_history`, FTS5 index, `history_enabled` on `connections`.
- [ ] Record each statement from the exec job.
- [ ] `history_search(connection_id?, query, limit, offset)`, `history_delete(ids)`,
      `history_clear(connection_id)`, `history_export(...)` (Rust-side save dialog).
- [ ] Retention pruning (count and age), with settings.

### IPC

- [ ] Commands above; capabilities and bindings.

### Frontend

- [ ] History popup (Ctrl+Alt+E default) with search box, connection filter, status icons,
      duration.
- [ ] Insert into editor (at caret) and open in new console.
- [ ] Delete entry and clear for a connection, with confirmation.
- [ ] Connection dialog: "Record query history" checkbox.
- [ ] Settings: retention count and age.

### Tests

- [ ] Store: migration on empty and upgraded databases.
- [ ] Integration: success, error and cancelled runs are all recorded with the right status.
- [ ] A connection with history disabled writes no rows (test asserts on the table).
- [ ] Retention prunes oldest first at the limit.
- [ ] FTS search finds by table name and keyword.

### Docs

- [ ] Mark M5.1 done in `mvp-and-milestones.md`.

## Acceptance criteria

- [ ] History records every run, including failures and cancels.
- [ ] Disabling history for a connection writes nothing for it.
- [ ] Search over 10,000 entries returns in under 100 ms.

## Risks and open questions

- History contains literals, which may be sensitive. The disable flag is the MVP answer; redaction
  is Later. State this in the connection dialog's help text.

## Progress log

| Date | Note |
| ---- | ---- |
