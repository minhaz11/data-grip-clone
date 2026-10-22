# Step 07: Result grid gaps and table browsing

| Field        | Value                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Milestone    | M4.8                                                                                                          |
| Status       | Not started                                                                                                   |
| Depends on   | 03, 04                                                                                                        |
| Requirements | REQ-GRID-01, 04, 06, 07, 08, 09, 12, 15, 16; REQ-EXEC-02; REQ-IMPEX-07, REQ-IMPEX-08; REQ-EXPL-06 (Open data) |
| Started      | -                                                                                                             |
| Finished     | -                                                                                                             |

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

- [ ] TSV, SQL INSERT and Markdown writers in `quarry-io`, with NULL text and quoting options.
- [ ] `result_copy(result_id, scope, format, options)` writing to the clipboard from Rust.
- [ ] Export cancel (`result_export_cancel`) and `.partial` cleanup.
- [ ] Table browse: `table_open(source_id, ObjectRef, where, order_by)` creating a cursor result.

### IPC

- [ ] Commands above; capabilities and bindings.

### Frontend

- [ ] Range selection (mouse, Shift+arrows, Ctrl+A) in `ResultGrid.tsx`.
- [ ] Copy menu with scope labels: Selection / Page / Entire result.
- [ ] Aggregate bar: count, sum, avg, min, max for numeric selections.
- [ ] Column header menu: hide, show all, reorder by drag; persisted per tab.
- [ ] Edit bar: Clone row, Revert selected, Set DEFAULT.
- [ ] Result tabs: pin, and a setting for reuse vs new tab per run.
- [ ] Explorer "Open data" on tables and views; WHERE / ORDER BY bar with history and clear.
- [ ] Export dialog: new formats, NULL text, quoting, clipboard target, Cancel button.

### Tests

- [ ] Unit: each writer escapes delimiters, quotes, newlines and NULL vs empty string.
- [ ] Unit: copying a selection over unloaded rows never requests more than 2 pages at once.
- [ ] Integration: export cancel leaves no file behind.
- [ ] Integration: table browse with WHERE text on a read-only source rejects a write function
      call in the WHERE text.
- [ ] UI: hidden and reordered columns survive a re-run and app restart.

### Docs

- [ ] Mark M4.8 done in `mvp-and-milestones.md`; update M3.3 "Not yet".

## Acceptance criteria

- [ ] Copy output for each format round-trips through a parser for that format (CSV/TSV/JSON) or
      runs as SQL (INSERT) against the disposable server.
- [ ] "Open data" grids are editable when the table qualifies, using the M4.2 rules.
- [ ] Export can be cancelled and leaves no partial file.

## Risks and open questions

- Free-form WHERE text can contain side-effecting function calls; the classifier sees only the
  wrapped SELECT. Decide whether read-only sources run browse queries in a read-only transaction
  (they already use `default_transaction_read_only`).

## Progress log

| Date | Note |
| ---- | ---- |
