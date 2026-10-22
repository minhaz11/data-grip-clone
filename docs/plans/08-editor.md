# Step 08: Editor gaps

| Field        | Value                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| Milestone    | M4.7                                                                                      |
| Status       | Done                                                                                      |
| Depends on   | 03                                                                                        |
| Requirements | REQ-EDIT-04, 05, 07, 10, 11; REQ-EXEC-01, REQ-EXEC-03; REQ-ERR-01, REQ-ERR-02, REQ-ERR-08 |
| Started      | 2026-10-23                                                                                |
| Finished     | 2026-10-23                                                                                |

## Goal

The SQL editor handles parameters, shows server notices, warns about long queries, resolves
names through the console's schema, and completes functions and joins.

## Scope

- Parameter prompts for `:name`, `${name}` and `$1`.
- Execution target policy setting and chooser.
- NOTICE messages in Output.
- Long-query notice and completion notification.
- Completion: functions, JOIN suggestions from FKs, fuzzy matching.
- Schema resolution via the console's `search_path` (from step 03).
- Output log search and clear; next/previous error; hover on error markers.
- Statement timeout setting.

## Out of scope

- Inspections, EXPLAIN tree view, formatter schemes (Later backlog).

## Design notes

- **Parameters**: detect in the TS splitter's token stream (`lib/sql/statements.ts`), so strings,
  comments and dollar quotes are skipped. Values are sent as bind parameters, not substituted into
  text, using the extended protocol for that statement. If a statement has parameters, it cannot
  use the simple-query path; check how this interacts with the cursor path (DECLARE with params).
  Remember values per console in workspace state.
- **NOTICE**: `tokio-postgres` delivers notices as `AsyncMessage::Notice` from the connection task.
  Route them to the job running on that session and emit them on the job's `Channel` as a new
  `ExecEvent::Notice`.
- **Long query**: a timer in the UI per job; notification via a small notification center (also
  used later by staleness and open-transaction warnings).
- **Completion**: functions from `pg_proc` added to the catalog cache; JOIN suggestions from the FK
  data loaded in step 04; fuzzy matching in `suggestions.ts`.
- **Statement timeout**: a setting applied with `SET statement_timeout` per session, 0 = off.

## Tasks

### Backend

- [x] `ExecEvent::Notice` and routing from the connection task to the active job.
- [x] Parameterized statement execution (extended protocol) including the cursor path.
- [x] Statement timeout applied per session from settings (enforced by the session; see Deviations).
- [x] Functions in the completion catalog command.

### IPC

- [x] Extend `ExecRequest` with parameter values; bindings regenerated.

### Frontend

- [x] Parameter detection in the splitter; prompt dialog; remembered values per console.
- [x] Settings: caret-outside-statement behaviour, multi-statement selection behaviour, chooser.
- [x] Output: notices, tx mode per entry, search, clear.
- [x] Long-query notice (default 20 s, configurable) and completion notification.
- [x] Next/previous error navigation (F8 / Shift+F8 for now, final keys in step 10) and hover text.
- [x] Completion: functions with signatures, JOIN ... ON suggestions from FKs, fuzzy matching.
- [x] Completion resolves unqualified names using the console's schema.
- [x] Statement timeout setting in Settings.

### Tests

- [x] Unit: parameter detection skips strings, comments, dollar quotes and `::` casts.
- [x] Integration: parameter values bind with the right types; an injection attempt stays a value.
- [x] Integration: `RAISE NOTICE` from a DO block appears as an event in order.
- [x] Integration: statement timeout cancels with the right message.
- [x] Unit: JOIN suggestion uses the FK columns; fuzzy matching ranks exact prefix first.

### Docs

- [x] Mark M4.7 done in `mvp-and-milestones.md`; update M3.2 "Not yet".

## Acceptance criteria

- [x] A statement with `:id` prompts once, runs with a bound value, and remembers it.
- [x] Notices appear in Output for the console that ran the statement only.
- [x] Completion offers functions and FK joins on the disposable server's seeded schema.

## Risks and open questions

- `$1` is also valid inside function bodies; only prompt for top-level statement parameters.
  Resolved: dollar-quoted and quoted bodies are skipped, and `PREPARE` statements are left alone.
- Parameters and `cursor_eligible` statements: confirmed, `DECLARE … CURSOR` takes bind
  parameters through the extended protocol (integration-tested).

## Deviations from the plan

- **Statement timeout is enforced by the session, not with `SET statement_timeout`.** The
  integration test showed queries never timed out: PostgreSQL disables the timeout before the
  commit that materializes a `WITH HOLD` cursor, which is where a query does its work. The
  session now cancels through the out-of-band cancel once the limit passes and reports
  "Cancelled by the statement timeout after N s" (SQLSTATE 57014, shown as an error, not as a
  user cancel). 0 means no limit; the server's own setting is left alone.
- **Parameters are bound in text format** (`ToSql::encode_format` = Text): the server parses
  each value for the type it inferred, so any type works without client-side type mapping.
  Placeholders are padded to the original length so server error positions still point at the
  console text. Bound statements outside a cursor (`INSERT … RETURNING`, `CALL`) report their
  row count only: their rows would arrive in binary form.
- **Parameter patterns are built in** (`:name`, `${name}`, `$1`) rather than configurable
  regexes; `:name` and `${name}` share a value.
- **Error navigation uses F8 / Shift+F8** (as in VS Code): F2 already edits a grid cell.
- **Output** became a per-console log of runs (last 50) instead of the latest run only; the
  Clear button is "Clear output".
- **Functions** come from a new `functions` metadata level; JOIN suggestions use the foreign
  keys `object_details` already returns, cached per table.
- Added a small notification center (toasts plus a status bar list), to be reused for stale
  metadata and open-transaction warnings.

## Progress log

| Date       | Note                                                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-23 | Found that `statement_timeout` never applies to queries run through `WITH HOLD` cursors (the timeout is disabled before the commit that runs them); moved enforcement into the session.                                     |
| 2026-10-23 | Notices needed the connection task to be driven with `poll_message` instead of awaited; notices are handed to the running job's sink in server order.                                                                       |
| 2026-10-23 | The DDL tab scan (step 05) failed now and then: axe sampled Monaco's "read-only editor" message mid fade-in, so its colors were blended. The test now dismisses it and waits before scanning (16 of 16 repeated runs pass). |
| 2026-10-23 | Checks: 95 Rust unit, 59 PostgreSQL integration, 190 frontend unit plus the timing test, 28 E2E.                                                                                                                            |
