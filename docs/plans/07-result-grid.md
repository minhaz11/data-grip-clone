# Step 07: Result grid gaps and table browsing

| Field        | Value                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Milestone    | M4.8                                                                                                          |
| Status       | Done                                                                                                          |
| Depends on   | 03, 04                                                                                                        |
| Requirements | REQ-GRID-01, 04, 06, 07, 08, 09, 12, 15, 16; REQ-EXEC-02; REQ-IMPEX-07, REQ-IMPEX-08; REQ-EXPL-06 (Open data) |
| Started      | 2026-10-23                                                                                                    |
| Finished     | 2026-10-23                                                                                                    |

## Goal

The grid covers daily data work: select ranges and copy them in useful formats, see aggregates,
arrange columns, open any table's data from the explorer with a WHERE/ORDER BY bar, and export in
more formats with a Cancel button.

## Scope

- Multi-cell selection, Copy as TSV/CSV/JSON/SQL INSERT/Markdown with explicit scopes.
- Selection aggregates.
- Column hide/show and reorder, persisted per tab.
- Clone row, Revert selection, DEFAULT setter for existing cells.
- Pinned result tabs and a reuse-or-new-tab setting.
- Table browsing ("Open data") with a free-form WHERE / ORDER BY bar and filter history.
- Export: TSV, SQL INSERT, Markdown, NULL text and quoting options, clipboard target, Cancel.

## Out of scope

- Value editor panel, transpose, tree view, FK navigation (Later backlog).

## Design notes

- **Selection model**: rectangular ranges over virtual rows. Copying "selection" uses cached pages;
  rows not yet fetched are fetched page by page (never more than 2 pages over IPC at once, the M3.3
  rule). "Entire result" copy goes through Rust like export, to the clipboard plugin, with a
  confirmation above a row threshold.
- **Copy formats**: implement in `quarry-io` so copy and export share one writer per format. SQL
  INSERT needs the source table name; when the result is not editable (no single base table), use
  a placeholder name the user is told about.
- **Aggregates**: computed in the UI over selected cells that are loaded; numeric detection from
  column type. If the selection includes unloaded rows, say "loaded rows only" or fetch on demand
  with a cap.
- **Table browsing**: "Open data" creates a result tab bound to a table, running
  `SELECT * FROM <qualified table>`; it is editable through the M4.2 path. The WHERE / ORDER BY bar
  takes free text, which is user SQL: it runs through the classifier and read-only guard, wrapped
  as `SELECT * FROM t WHERE (<text>) ORDER BY <text>`. The M4.1 structured filter stays available
  for ad-hoc results.
- **Export cancel**: the writer thread already uses a bounded queue; add a cancel flag that stops
  fetching and deletes the `.partial` file.

## Tasks

### Backend

- [x] TSV, SQL INSERT and Markdown writers in `quarry-io`, with NULL text and quoting options.
- [x] `result_copy` writing the entire result to the clipboard from Rust; `result_format` for
      selections and pages the UI holds.
- [x] Export cancel (`result_export_cancel`) and `.partial` cleanup.
- [x] Table browse: a cursor result for `SELECT *` with the WHERE / ORDER BY text (built in the
      UI and run through the console path; see Deviations).

### IPC

- [x] Commands above; capabilities and bindings.

### Frontend

- [x] Range selection (mouse, Shift+arrows, Ctrl+A) in `ResultGrid.tsx`.
- [x] Copy dialog with scope labels: Selection / Page / Entire result.
- [x] Aggregate bar: count, sum, avg, min, max for numeric selections.
- [x] Column header menu: hide, show all, reorder by drag; persisted per tab.
- [x] Edit bar: Clone row, Revert selected, Set DEFAULT.
- [x] Result tabs: pin, and a setting for reuse vs new tab per run.
- [x] Explorer "Open data" on tables and views; WHERE / ORDER BY bar with history and clear.
- [x] Export dialog: new formats, NULL text, quoting, clipboard target, Cancel button.

### Tests

- [x] Unit: each writer escapes delimiters, quotes, newlines and NULL vs empty string.
- [x] Unit: copying a selection over unloaded rows never requests more than 2 pages at once.
- [x] Integration: export cancel leaves no file behind.
- [x] Integration: table browse with WHERE text on a read-only source rejects a write function
      call in the WHERE text.
- [x] UI: hidden and reordered columns survive a re-run and app restart.

### Docs

- [x] Mark M4.8 done in `mvp-and-milestones.md`; update M3.3 "Not yet".

## Acceptance criteria

- [x] Copy output for each format round-trips through a parser for that format (CSV/TSV/JSON) or
      runs as SQL (INSERT) against the disposable server.
- [x] "Open data" grids are editable when the table qualifies, using the M4.2 rules.
- [x] Export can be cancelled and leaves no partial file.

## Risks and open questions

- Free-form WHERE text can contain side-effecting function calls; the classifier sees only the
  wrapped SELECT. Decided: read-only sources rely on `default_transaction_read_only`, which
  rejects writes on the server (integration-tested with `nextval()`).

## Deviations from the plan

- **No `table_open` command.** Open data builds `SELECT * FROM <quoted table> WHERE (<text>`,
  newline, `) ORDER BY <text>` in the UI and runs it through the console execution path in the
  data source's shared session. Paging, sorting, filtering, editing, Stop and cursor release then
  work exactly as for console results. The text is checked to stay one read statement
  (`splitStatements` + `classify`); the closing parenthesis is on its own line so a trailing
  `--` comment cannot swallow it.
- **Read-only browse (the open risk):** read-only sources already run every statement with
  `default_transaction_read_only`, so write functions in the WHERE text fail on the server
  (`nextval()`: 25006). Integration-tested; no separate transaction needed.
- **Copy dialog instead of a copy menu:** one dialog chooses scope, format and options (the same
  options as export). Ctrl+C copies one cell as is, or a range as TSV without a header.
- **Selection copies use `result_format`:** the UI gathers rows (pending edits applied, at most
  100,000 rows) and Rust formats them with the export writers. Only the entire result is copied
  by Rust straight to the clipboard (`result_copy`, a 64 MB cap). The entire result means every
  column as stored on the server; the dialog says so.
- **Set DEFAULT** needed `RowChange::Update.defaults` (`SET col = DEFAULT`); the original value
  is still checked. **Clone** leaves primary key columns to their defaults.
- **Result tabs**: a `resultTabs` setting (`reuse` or `new`); pinned results always stay, at most
  5 unpinned kept results per console.
- **Filter history** is kept for the app session only; persistent history comes with query
  history (step 09).
- Added `tauri-plugin-clipboard-manager` (used from Rust only; the WebView gets no clipboard
  permission) and `csv` as a test-only dependency for the round-trip test.

## Progress log

| Date       | Note                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-23 | Aggregates sum plain decimals exactly with BigInt (integer and numeric text forms), so a selection of large `int8` values does not drift; exponent forms fall back to floating point and are marked.                                                                                    |
| 2026-10-23 | The new grid scan found an old problem: the run summary (`aria-live`) sat inside the result `tablist`. Moved out. A late export progress message could also overwrite the finished summary; progress now only updates its own running job.                                              |
| 2026-10-23 | The explorer timing test (1,000 tables, 1 s budget) failed while the system file indexer used most of the CPU. Side by side, the previous commit measured slower (1,663 and 1,998 ms) than this step (1,311 and 1,641 ms), so not a regression; it passed 3 of 3 once the load dropped. |
| 2026-10-23 | Checks: 94 Rust unit, 55 PostgreSQL integration, 169 frontend unit plus the timing test, 26 E2E.                                                                                                                                                                                        |
