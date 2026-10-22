# Step 08: Editor gaps

| Field        | Value                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| Milestone    | M4.7                                                                                      |
| Status       | Not started                                                                               |
| Depends on   | 03                                                                                        |
| Requirements | REQ-EDIT-04, 05, 07, 10, 11; REQ-EXEC-01, REQ-EXEC-03; REQ-ERR-01, REQ-ERR-02, REQ-ERR-08 |
| Started      | -                                                                                         |
| Finished     | -                                                                                         |

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

- [ ] `ExecEvent::Notice` and routing from the connection task to the active job.
- [ ] Parameterized statement execution (extended protocol) including the cursor path.
- [ ] Statement timeout applied per session from settings.
- [ ] Functions in the completion catalog command.

### IPC

- [ ] Extend `ExecRequest` with parameter values; bindings regenerated.

### Frontend

- [ ] Parameter detection in the splitter; prompt dialog; remembered values per console.
- [ ] Settings: caret-outside-statement behaviour, multi-statement selection behaviour, chooser.
- [ ] Output: notices, tx mode per entry, search, clear.
- [ ] Long-query notice (default 20 s, configurable) and completion notification.
- [ ] Next/previous error navigation (F2 / Shift+F2 style, final keys in step 10) and hover text.
- [ ] Completion: functions with signatures, JOIN ... ON suggestions from FKs, fuzzy matching.
- [ ] Completion resolves unqualified names using the console's schema.
- [ ] Statement timeout setting in Settings.

### Tests

- [ ] Unit: parameter detection skips strings, comments, dollar quotes and `::` casts.
- [ ] Integration: parameter values bind with the right types; an injection attempt stays a value.
- [ ] Integration: `RAISE NOTICE` from a DO block appears as an event in order.
- [ ] Integration: statement timeout cancels with the right message.
- [ ] Unit: JOIN suggestion uses the FK columns; fuzzy matching ranks exact prefix first.

### Docs

- [ ] Mark M4.7 done in `mvp-and-milestones.md`; update M3.2 "Not yet".

## Acceptance criteria

- [ ] A statement with `:id` prompts once, runs with a bound value, and remembers it.
- [ ] Notices appear in Output for the console that ran the statement only.
- [ ] Completion offers functions and FK joins on the disposable server's seeded schema.

## Risks and open questions

- `$1` is also valid inside function bodies; only prompt for top-level statement parameters.
- Parameters and `cursor_eligible` statements: confirm DECLARE ... CURSOR accepts bind parameters
  through the extended protocol.

## Progress log

| Date | Note |
| ---- | ---- |
