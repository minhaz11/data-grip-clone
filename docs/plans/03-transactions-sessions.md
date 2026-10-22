# Step 03: Transactions and sessions

| Field        | Value                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Milestone    | M4.6                                                                                                          |
| Status       | Not started                                                                                                   |
| Depends on   | 01                                                                                                            |
| Requirements | REQ-TX-01, REQ-TX-02, REQ-EDIT-09, REQ-GRID-10, REQ-ERR-09, REQ-SESS-01, REQ-SESS-02, REQ-CONN-13, REQ-ERR-05 |
| Started      | -                                                                                                             |
| Finished     | -                                                                                                             |

## Goal

A console can run in Manual transaction mode, with visible Commit and Rollback and a clear
"transaction open" indicator, and the app never silently loses or commits an open transaction.
Consoles can share the data source's session or have their own, each with its own `search_path`.

## Scope

- Auto/Manual mode per session, isolation level, default mode per connection.
- Transaction state tracking and display (toolbar, status bar, console tab).
- Guards on close tab, disconnect and quit with an open transaction.
- Shared vs dedicated sessions per console; per-console schema (`search_path`) restored on restart.
- Cancel escalation: second stage that drops the session.

## Out of scope

- Savepoints UI.
- Making row edits join the console transaction (they stay on their own short-lived connection,
  as M4.2 decided; revisit only if users ask).

## Design notes

- **Session registry** (`src-tauri/src/sessions.rs`): today `live: HashMap<String, Arc<dyn Session>>`
  is keyed by data source id. Change the key to a `SessionKey { source_id, slot }` where `slot` is
  `Shared` or `Console(name)`. Connect/disconnect of a data source closes all its slots. Status
  events carry the key.
- **Jobs** (`src-tauri/src/exec.rs`): "one job per data source at a time" becomes one job per
  session key, so two dedicated consoles on the same source can run at once.
- **Transaction state**: verify whether `tokio-postgres` exposes the ReadyForQuery transaction
  status. If not, track it in `PgSession`: set on `BEGIN`/`START TRANSACTION`, cleared on
  `COMMIT`/`ROLLBACK`/`END`, set to "failed" on an error inside a transaction, and confirm with
  `SELECT now() = statement_timestamp()` style checks only if needed. Emit a `tx-status` event
  (`idle` / `active` / `failed`) after every statement.
- **Manual mode**: before the first statement of a job, if the session is idle and mode is Manual,
  send `BEGIN ISOLATION LEVEL <level>`. Commit/Rollback are commands, not typed SQL, so they work
  even while the editor has unsaved text.
- **Cursors** (M3.3): results use `SCROLL ... WITH HOLD` cursors, materialized at commit when
  declared inside a transaction. In Manual mode a large result inside an open transaction is not
  materialized until commit. Decide: declare without HOLD inside a transaction and invalidate on
  commit/rollback, or keep HOLD and accept the cost. Needs a test either way.
- **Storage**: `crates/store` migration 3 adds `default_tx_mode` and `default_isolation` to
  `connections`. Per-console session slot and schema go into `workspace_state`.
- **Quit guard**: handle Tauri's window close-requested event; ask the UI whether any session has
  an open transaction, and prompt before closing.

## Tasks

### Backend

- [ ] Close the read-only gap found in step 01 (ADR-0006): on read-only sources, block `SET`
      / `RESET` of `default_transaction_read_only` and `transaction_read_only` and
      `SET SESSION CHARACTERISTICS AS TRANSACTION`, with an integration test proving a writing
      function cannot run after such an attempt.
- [ ] Spike: confirm how to read transaction status from `tokio-postgres`; record the answer here.
- [ ] Add `transaction_status()` and `begin(isolation)` / `commit()` / `rollback()` to the
      `Session` trait (`crates/db-core/src/lib.rs`) and implement them in `PgSession`.
- [ ] Track state through `execute` (including failed-transaction state, SQLSTATE 25P02).
- [ ] Resolve the cursor-in-transaction behaviour and implement it.
- [ ] `SessionKey` in the registry; connect/disconnect per slot and per source.
- [ ] One job per session key in `exec.rs`.
- [ ] `set_search_path(schemas)` per session, applied after connect and on change.
- [ ] Cancel stage 2: `session_drop` closes the session even if cancel did not stop the query.
- [ ] Store migration 3: `default_tx_mode`, `default_isolation` on `connections`, with migration
      tests on an empty and an upgraded database.

### IPC

- [ ] Commands: `tx_commit`, `tx_rollback`, `tx_set_mode`, `session_open_console`,
      `session_close_console`, `session_set_schema`, `session_drop`.
- [ ] Event: `tx-status` keyed by session.
- [ ] Add the new commands to `capabilities/default.json` and the generated bindings.

### Frontend

- [ ] Toolbar: Auto/Manual toggle and isolation selector; Commit and Rollback shown only in Manual.
- [ ] Indicator: open-transaction badge on the console tab and in the status bar; failed state
      tells the user to roll back.
- [ ] Console session picker: shared or dedicated; schema selector per console.
- [ ] Guard dialogs: close tab, disconnect, and quit with an open transaction (Commit / Rollback /
      Cancel, Cancel focused).
- [ ] Cancel: after a timeout, offer "Drop connection" with the "may still run on the server"
      message.
- [ ] Connection dialog: default transaction mode and isolation.
- [ ] Output log entries show the transaction mode.

### Tests

- [ ] Integration: Manual mode keeps changes invisible to a second session until commit.
- [ ] Integration: rollback discards; failed transaction reports `failed` and recovers on rollback.
- [ ] Integration: dedicated sessions run concurrently on one data source.
- [ ] Integration: paging a result works inside and after a manual transaction.
- [ ] Integration: `search_path` per console resolves unqualified names differently.
- [ ] UI: each guard dialog appears and Cancel keeps the transaction open.
- [ ] UI: production source still asks for write confirmation in Manual mode.

### Docs

- [ ] Mark M4.6 done in `mvp-and-milestones.md` with a "Done:" summary.

## Acceptance criteria

- [ ] An uncommitted change is never committed or lost without the user choosing Commit, Rollback
      or Drop in a dialog (tab close, disconnect, quit).
- [ ] The transaction indicator matches the server state after every statement, including errors.
- [ ] Two dedicated consoles on one source run queries at the same time.
- [ ] Read-only sources still reject writes in Manual mode.
- [ ] Row edits (M4.2) remain isolated from an open console transaction (existing test still passes).

## Risks and open questions

- Transaction status visibility in `tokio-postgres` (spike above).
- Cursor behaviour inside transactions (design note above).
- Number of connections: dedicated sessions multiply connections per source; consider a cap.

## Progress log

| Date | Note |
| ---- | ---- |
