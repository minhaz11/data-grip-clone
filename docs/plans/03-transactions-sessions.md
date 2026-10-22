# Step 03: Transactions and sessions

| Field        | Value                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Milestone    | M4.6                                                                                                          |
| Status       | In progress                                                                                                   |
| Depends on   | 01                                                                                                            |
| Requirements | REQ-TX-01, REQ-TX-02, REQ-EDIT-09, REQ-GRID-10, REQ-ERR-09, REQ-SESS-01, REQ-SESS-02, REQ-CONN-13, REQ-ERR-05 |
| Started      | 2026-10-22                                                                                                    |
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

## Design notes (as built)

- **Transaction state** (`crates/db-postgres/src/lib.rs`, `txctl.rs`): `tokio-postgres` 0.7.18
  discards the ReadyForQuery status (`Message::ReadyForQuery(_)`), so the session probes with
  `SAVEPOINT quarry_tx_probe`: success (then released) means an open block, 25P01 none, 25P02 an
  aborted one. It probes only after statements that can change the state (transaction control,
  CALL, DO) or after an error inside a block. Neither the probe nor the read-only check (`SHOW`)
  takes a snapshot, so `BEGIN; SET TRANSACTION …` keeps working.
- **Manual mode** sends `BEGIN ISOLATION LEVEL …` before the first statement that needs a block,
  never before transaction control or statements that refuse a block (VACUUM, CREATE/DROP
  DATABASE or TABLESPACE, ALTER SYSTEM, `… CONCURRENTLY`, REINDEX DATABASE/SYSTEM). Procedures
  that commit internally fail in Manual mode (the server refuses); use Auto for them.
- **Session contract** (`db-core`): `tx_status`, `tx_settings`/`set_tx_settings`, `commit`,
  `rollback`, `set_schema`, `fork` (same credentials, new connection), `abort` (drop the
  connection without waiting; running calls fail as connection lost).
- **Registry** (`src-tauri/src/sessions.rs`): keyed by `SessionKey { sourceId, console? }`.
  Console sessions are forked lazily on their first run. Chosen settings persist per key; the
  data source's defaults (store migration 3: `tx_mode`, `isolation`) apply otherwise. A
  `session-state` event carries `{ session, open, status, settings }` on every change.
- **Schema per console**: sent with each run (`ExecRequest.schema`) and with result refinements;
  the registry re-applies it only when it differs from what it last set, so a user's own
  `SET search_path` stays in effect. Set with `quote_ident` on the server, followed by the
  server's default path. (This replaced the planned `session_set_schema` command.)
- **Cursors in transactions**: kept as `SCROLL … WITH HOLD`; paging works inside and after a
  commit, and a rollback drops cursors declared in it (paging then reports "no longer
  available"). Tested.
- **Quit**: Rust holds the window close (`CloseRequested`) when any session has an open or
  failed transaction and emits `quit-requested`; the UI asks and calls `app_quit(commit |
rollback)`, which resolves every open transaction and exits, or reports which one failed.
- **Read-only gap from step 01** (ADR-0006) closed in both layers: the classifier flags
  read-write switches (`unlocksWrites`), and the session restores the read-only default before
  each statement outside a block and rolls back any block made read-write.

## Tasks

### Backend

- [x] Close the read-only gap found in step 01 (ADR-0006): on read-only sources, block `SET`
      / `RESET` of `default_transaction_read_only` and `transaction_read_only` and
      `SET SESSION CHARACTERISTICS AS TRANSACTION`, with an integration test proving a writing
      function cannot run after such an attempt.
- [x] Spike: confirm how to read transaction status from `tokio-postgres`; record the answer here.
- [x] Add `transaction_status()` and `begin(isolation)` / `commit()` / `rollback()` to the
      `Session` trait (`crates/db-core/src/lib.rs`) and implement them in `PgSession`.
- [x] Track state through `execute` (including failed-transaction state, SQLSTATE 25P02).
- [x] Resolve the cursor-in-transaction behaviour and implement it.
- [x] `SessionKey` in the registry; connect/disconnect per slot and per source.
- [x] One job per session key in `exec.rs`.
- [x] `set_search_path(schemas)` per session, applied after connect and on change.
- [x] Cancel stage 2: `session_drop` closes the session even if cancel did not stop the query.
- [x] Store migration 3: `default_tx_mode`, `default_isolation` on `connections`, with migration
      tests on an empty and an upgraded database.

### IPC

- [x] Commands: `tx_commit`, `tx_rollback`, `tx_set_mode`, `session_open_console`,
      `session_close_console`, `session_set_schema`, `session_drop`. As built: `session_state`,
      `session_set_tx`, `tx_commit`, `tx_rollback`, `session_close`, `session_drop`, `app_quit`;
      console sessions open on first run and the schema travels with each run.
- [x] Event: `tx-status` keyed by session (as built: `session-state`, plus `quit-requested`).
- [x] Add the new commands to `capabilities/default.json` and the generated bindings.

### Frontend

- [x] Toolbar: Auto/Manual toggle and isolation selector; Commit and Rollback shown only in Manual.
- [x] Indicator: open-transaction badge on the console tab and in the status bar; failed state
      tells the user to roll back.
- [x] Console session picker: shared or dedicated; schema selector per console.
- [x] Guard dialogs: close tab, disconnect, and quit with an open transaction (Commit / Rollback /
      Cancel, Cancel focused).
- [x] Cancel: after a timeout, offer "Drop connection" with the "may still run on the server"
      message.
- [x] Connection dialog: default transaction mode and isolation.
- [x] Output log entries show the transaction mode.

### Tests

- [x] Integration: Manual mode keeps changes invisible to a second session until commit.
- [x] Integration: rollback discards; failed transaction reports `failed` and recovers on rollback.
- [x] Integration: dedicated sessions run concurrently on one data source.
- [x] Integration: paging a result works inside and after a manual transaction.
- [x] Integration: `search_path` per console resolves unqualified names differently.
- [x] UI: each guard dialog appears and Cancel keeps the transaction open.
- [x] UI: production source still asks for write confirmation in Manual mode.

### Docs

- [x] Mark M4.6 done in `mvp-and-milestones.md` with a "Done:" summary.

## Acceptance criteria

- [x] An uncommitted change is never committed or lost without the user choosing Commit, Rollback
      or Cancel in a dialog when closing a console, switching its session or data source,
      disconnecting or deleting a data source (UI tests).
- [ ] The same holds when quitting the desktop app: verify once by hand (open a Manual
      transaction, close the window, see the dialog, Cancel keeps the app open) or with
      `tauri-driver` in step 19. The dialog and `app_quit` are tested; the Rust window-close hold
      is not covered by an automated test.
- [x] The transaction indicator matches the server state after every statement, including errors.
- [x] Two dedicated consoles on one source run queries at the same time (forked sessions run
      concurrently against the server; jobs are limited per session key, not per source).
- [x] Read-only sources still reject writes in Manual mode.
- [x] Row edits (M4.2) remain isolated from an open console transaction (existing test still passes).

## Risks and open questions

- Dedicated sessions multiply connections per data source; there is no cap yet.
- The registry's Tauri-bound code (events, lazy fork, quit hold) has no Rust unit tests; it is
  covered through the database integration tests below it and the UI tests above it.
- A shared session's schema is re-applied per run; two consoles with different schemas on the
  shared session take turns, which is correct but costs one statement per switch.

## Progress log

| Date       | Note                                                                                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-22 | Spike answer: `tokio-postgres` discards ReadyForQuery's status; a savepoint probe gives the server's view. A first version checked read-write with a SELECT, which counts as a query and broke `BEGIN; SET TRANSACTION …`; switched to `SHOW` and added a test. |
| 2026-10-22 | E2E found the console toolbar scrolling sideways at 1400 px once the transaction controls were added (and a flaky click from it). The toolbar now wraps; the E2E test asserts nothing overflows.                                                                |
| 2026-10-22 | All checks green: 79 Rust unit, 44 PostgreSQL integration, 126 frontend unit, 16 E2E (WebKit and Chromium, 3 consecutive runs). The desktop app starts cleanly.                                                                                                 |
