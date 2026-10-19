# 05 — Result grid / data editor

## Sources

All fetched 2026-10-19 (WebFetch returns a model-generated summary of each page, not raw HTML; see Limitations).

- https://www.jetbrains.com/help/datagrip/table-editor.html
- https://www.jetbrains.com/help/datagrip/data-editor-and-viewer.html
- https://www.jetbrains.com/help/datagrip/working-with-the-data-editor.html
- https://www.jetbrains.com/help/datagrip/tables-view-data.html
- https://www.jetbrains.com/help/datagrip/tables-filter.html
- https://www.jetbrains.com/help/datagrip/tables-sort.html
- https://www.jetbrains.com/help/datagrip/rows.html
- https://www.jetbrains.com/help/datagrip/cells.html
- https://www.jetbrains.com/help/datagrip/submitting-and-reverting-changes.html
- https://www.jetbrains.com/help/datagrip/configuring-database-connections.html
- https://www.jetbrains.com/help/datagrip/viewing-query-results.html
- https://www.jetbrains.com/help/datagrip/query-execution.html
- https://www.jetbrains.com/help/datagrip/services-tool-window.html
- https://www.jetbrains.com/help/datagrip/settings-tools-database-data-views.html
- https://www.jetbrains.com/help/datagrip/data-extractors.html
- https://www.jetbrains.com/help/datagrip/export-data.html
- https://www.jetbrains.com/help/datagrip/editing-csv-and-tsv-files.html
- https://www.jetbrains.com/help/datagrip/data-sources-and-drivers-dialog.html

## Evidence legend

- [DOC] stated in fetched official JetBrains docs.
- [CFG] / [REA] local observation (only those given in the brief; none are specific to the grid except the CSV format set, see file 07).
- [ASSUMPTION] our inference, not verified.

## Observed workflows

1. **Open a grid on a table.** Double-click a table in Database Explorer, or select it and press F4, or use Edit Data (toolbar/context menu) -> a data editor tab opens in Table view mode [DOC]. Tabs for same-named tables from different schemas get the schema name appended; long data-source names (>20 chars) and qualified names (>36 chars) are truncated; the data-source name is hidden when only one source exists [DOC].
2. **Open a grid on query results.** Run a query in a console -> a Result tab appears in the Services tool window, or results show inline via "In-Editor Results" [DOC]. Query-result grids support sorting, adding/editing/removing rows through the same toolbar [DOC].
3. **Result tabs.** By default a new run reuses the same tab; setting "Open results in new tab" (Database > Query Execution) gives one tab per query [DOC]. Right-click tab -> Pin Tab keeps it in the tool window [DOC]. Text after `--` or `/*` in the comment preceding a query becomes the tab title by default; the marker and the feature are configurable [DOC]. With In-Editor Results on, multiple result sets stack vertically in the editor [DOC]. Compare Data in the Services window diffs two result sets, with a Tolerance parameter for how many differences still count as equal [DOC].
4. **Paging.** Toolbar: First / Previous / Next / Last page plus a page-size list; Prev/Next are Ctrl+Alt+Up/Down [DOC]. Navigation is inactive when all rows are already shown [DOC]. Default result limit is 500 rows; clearing "Limit page size to" (Settings > Database > Data Views / Data Editor and Viewer) then Reload Page (Ctrl+F5) removes the limit [DOC]. A changed page size is applied on reload [DOC]. Pagination control position is configurable (floating bottom / bottom-left / bottom-right / toolbar) and paging for in-editor results has its own default toggle [DOC]. "Result set prefetch size" sets rows fetched per chunk [DOC]. Update Interval allows periodic auto-refresh, pause, or custom interval [DOC].
5. **Sort.** Click the sort icon in a column header. For database-object grids this by default sends a new `ORDER BY` query (visible in the Services Output tab) [DOC]. Turning off "Sort via ORDER BY" (Show Options Menu) sorts client-side, only the current page [DOC]. Server-side sorting is unavailable for query result sets [DOC]. Sorting is not stacked by default; Alt+click adds a column; each sorted column shows a level number; marker states are none / ascending / descending [DOC]. The stacking modifier is configurable ("Add columns to sorting") [DOC]. A freeform ORDER BY field (expression without the keyword; Enter applies; clear icon or empty+Enter resets; arrow icon opens history) is available once the filter bar is shown [DOC]. "Sort tables by numeric primary key" (asc/desc) applies a default ORDER BY whenever a table is opened [DOC].
6. **Filter.** (a) WHERE field: type a condition without the keyword, Enter applies; `%` and `_` for LIKE; history via arrow; Show Filter toggles the bar (Ctrl+Alt+Shift+F is cited by the sort page for showing the filter) [DOC]. (b) Local filter: toolbar "Enable Local Filter" adds a filter icon to every column header; pick/type values; conditions are remembered across toggling; "Clear Local Filter For All Columns" is a searchable action [DOC]. (c) "Filter by" in cell context menu with options depending on the cell value [DOC]. (d) Ctrl+F -> "Filter Rows" for text search on the page [DOC]. Server-side (WHERE) filtering exists only for database-object data, not query results [DOC]. Setting "Enable local filter by default" applies it to each new grid [DOC]. Filter history size is a setting [DOC].
7. **Columns.** For DSV-as-table grids: hide columns from the column header menu and restore them from the column list; drag columns to reorder [DOC]. Resize behavior is not described in fetched pages [not documented].
8. **Edit a cell.** Enter or double-click; Ctrl+Space completion; Enter commits the edit locally; Escape cancels; read-only values cannot be edited [DOC]. Typing once with a range selected applies the value to all selected cells [DOC]. Completion draws from values already loaded in the column, not from a table query [DOC]. Set DEFAULT (Ctrl+Alt+D) and Set NULL (Ctrl+Alt+N) on cell [DOC]. "Edit as SQL Expression" / "Set SQL Expression" (e.g. NOW(), DEFAULT, subqueries) with "Convert to Literal" to go back [DOC]. Generate UUID, Load File..., Save LOB..., Change Display Type (16-byte values shown as UUID by default) [DOC].
9. **Value editor.** Shift+Enter or context menu "Open in Value Editor": Enter inserts newline, Ctrl+Enter saves, Escape restores initial value; Toggle Soft-Wrap; Toggle Formatting for one-line XML/JSON; array cells editable per element with "Hide Deleted Elements" [DOC]. "Maximum number of bytes loaded per value" limits LOB loading [DOC].
10. **Add / clone / delete rows.** Add Row: toolbar, context menu, or Alt+Insert; new rows take column defaults or NULL for unspecified cells [DOC]. Clone Row (Ctrl+D) places the copy at the end [DOC]. Delete Row: toolbar (Ctrl+Y), Delete, or Alt+Delete in menus; multi-select via gutter numbers or Ctrl+click [DOC]. The docs list conflicting shortcuts across pages for delete (Ctrl+Y / Delete / Alt+Delete) [DOC]. Truncate (Object Actions) removes all rows [DOC]. Pasting CSV lines onto selected rows replaces them and creates rows if needed [DOC]. Go To Row (Ctrl+G, `column:row` syntax) [DOC]. Related Rows (F4) navigates FK references, with a popup if multiple matches [DOC].
11. **Pending changes, submit, revert.** Edits stay local until Submit (Ctrl+Enter) [DOC]. Preview Pending Changes opens a DML Preview popup showing generated statements [DOC]. Revert Selected (Ctrl+Alt+Z) reverts the selection, or whole table when nothing is selected [DOC]. Array changes persist until Revert Changes in the value editor, Revert Selected, or closing the grid [DOC]. Visual highlighting (colors) of pending-changed cells/rows is NOT described in any fetched page [not documented].
12. **Transaction modes (Tx).** Tx:Auto: Submit commits immediately; Submit and Commit / Roll Back hidden; changes cannot be rolled back [DOC]. Tx:Manual: Submit stores changes in an open transaction; Submit and Commit (Ctrl+Alt+Shift+Enter) makes them permanent; Roll Back reverts uncommitted submitted work [DOC]. The Tx control also picks isolation level (DBMS-dependent) [DOC]. Defaults are set per data source (Options > Transaction control) and apply to new consoles/files; a session can override from the toolbar [DOC]. "Submit changes immediately" (Data Modification setting) auto-submits each edit [DOC]. Read-only checkbox on the data source blocks edits in the data editor, while consoles may still modify data if the driver lacks read-only support [DOC]. A per-editor read-only toggle sits in the lower-right of the editor [DOC].
13. **Conflicts.** If someone changed the object being edited, submitting shows a conflict notification with a Merge three-way diff (Accept/Ignore per hunk, "Save changes and finish merging") [DOC]. This page text pertains to DDL editing context; applicability to row data is unclear [ASSUMPTION].
14. **View modes (View as).** Table (default), Tree (key/value, expandable, for JSON/arrays), Text (rendered through the chosen data extractor), Transpose (combinable with other modes; default via "Automatically transpose tables": Never / If one record / Always) [DOC]. Record View side panel (Ctrl+Shift+Enter) with 1- or 2-column layout [DOC].
15. **Aggregate view.** Select multiple cells -> Show Aggregate View; gear toggles which aggregates are shown; custom aggregators are scripts in the Extensions folder; Copy Aggregation Result (SUM) is Ctrl+Shift+C [DOC].
16. **Copy / export formats.** Data Extractors list (next to Export Data) picks the format used by Copy and by Text view: SQL Inserts, SQL Updates, Where Clause, CSV, TSV, Pipe-separated, Excel, HTML, JSON, Markdown, One-row, XML, Pretty (.txt) and scripted ones [DOC]. Ctrl+C copies only selected rows of the current page; Ctrl+A then Ctrl+C copies the whole page; "Export Table to Clipboard" copies the whole result ignoring page limit [DOC]. Last used extractor becomes default for new tabs [DOC]. Paste Format option controls how clipboard text is interpreted on paste [DOC].
17. **Other grid tools.** Find on Current Page (Ctrl+F), Full-Text Search (Ctrl+Alt+Shift+F), Show Chart (Bar/Pie/Area/Line/Scatter/Bubble/Stock/AreaRange/Histogram, PNG export), View Query / Copy Query to Console, Reset View, Compare Data, Copy to Database, Go to DDL [DOC]. "Alternate row colors", custom font, boolean as text/checkbox, number and date/time formats, display time zone are appearance settings [DOC].
18. **Cancel / reload.** Cancel Running Statements (Ctrl+F2); Reload Page (Ctrl+F5) re-queries [DOC].

## Keyboard shortcuts

| Action                         | Windows/Linux                                 | Source |
| ------------------------------ | --------------------------------------------- | ------ |
| Previous / next page           | Ctrl+Alt+Up / Ctrl+Alt+Down                   | [DOC]  |
| Reload page                    | Ctrl+F5                                       | [DOC]  |
| Cancel running statements      | Ctrl+F2                                       | [DOC]  |
| Add row                        | Alt+Insert                                    | [DOC]  |
| Clone row                      | Ctrl+D                                        | [DOC]  |
| Delete row                     | Ctrl+Y / Delete / Alt+Delete (varies by page) | [DOC]  |
| Edit cell / commit local edit  | Enter / Enter                                 | [DOC]  |
| Cancel cell edit               | Escape                                        | [DOC]  |
| Open in value editor           | Shift+Enter                                   | [DOC]  |
| Save in value editor           | Ctrl+Enter                                    | [DOC]  |
| Set DEFAULT / NULL             | Ctrl+Alt+D / Ctrl+Alt+N                       | [DOC]  |
| Submit                         | Ctrl+Enter                                    | [DOC]  |
| Submit and Commit (Manual)     | Ctrl+Alt+Shift+Enter                          | [DOC]  |
| Revert selected                | Ctrl+Alt+Z                                    | [DOC]  |
| Find on page                   | Ctrl+F                                        | [DOC]  |
| Go to row                      | Ctrl+G                                        | [DOC]  |
| Related rows / open URL / file | F4                                            | [DOC]  |
| Copy / paste / copy SUM        | Ctrl+C / Ctrl+V / Ctrl+Shift+C                | [DOC]  |
| Record view                    | Ctrl+Shift+Enter                              | [DOC]  |
| Show filter / full-text search | Ctrl+Alt+Shift+F                              | [DOC]  |
| Quick documentation            | Ctrl+Q                                        | [DOC]  |

## Edge cases and error states

- Ctrl+Enter is overloaded: runs a query in the editor, submits in the grid, and saves in the value editor [DOC].
- Server-side sort/WHERE unavailable for query results; client-side sort affects only the loaded page, so it can misrepresent global order [DOC].
- Clearing the page-size limit on large tables loads everything; docs show no safeguard [DOC, absence].
- Tx:Auto edits "cannot be rolled back" [DOC]; read-only data sources may still allow writes from consoles [DOC].
- Value completion is limited to loaded data [DOC]. Local filter applies only to the loaded page [ASSUMPTION; pages say "current page" for find, not explicitly for local filter].
- Editing is allowed only when the source is a single editable table; behavior for joins/aggregates is not documented [not documented].
- Data editor on tabular files (Excel/JSON/Parquet via loaders) is read-only [DOC]; DSV save-back is not described [DOC, absence].

## Implementation requirements for our app

- REQ-GRID-01 (MVP): Result grid for query results and table browsing with virtualised rows and column headers; page-size selector, First/Prev/Next/Last, and an explicit "fetch all / no limit" option with a confirmation when the row count is large.
- REQ-GRID-02 (MVP): Default page size is configurable (initial value our choice; e.g. 500) and applied on reload; show "rows x-y of N?" with N lazy/unknown if not counted.
- REQ-GRID-03 (MVP): Sorting by header click; for table browsing, server-side `ORDER BY` with the generated SQL visible; for ad-hoc query results, client-side on loaded rows, labelled as "sorted on loaded rows only". Modifier-click for multi-column sort with level badges.
- REQ-GRID-04 (MVP): Filter bar with free-form WHERE and ORDER BY inputs (table browsing only), history dropdown, clear button.
- REQ-GRID-05 (Later): Per-column local filter and "find on page".
- REQ-GRID-06 (MVP): Column resize, hide/show, reorder; persisted per tab. Resize behavior is our own design [ASSUMPTION].
- REQ-GRID-07 (MVP): Cell editing for editable table grids with Enter/Escape semantics; NULL and DEFAULT setters; type-aware parsing; read-only cells visibly distinct.
- REQ-GRID-08 (MVP): Row add / clone / delete; staged locally; pending rows/cells visually distinguished (our own palette, accessible; not DataGrip's).
- REQ-GRID-09 (MVP): Pending-change model: Preview Changes shows generated DML; Submit sends; Revert (selection or all). Never auto-submit by default.
- REQ-GRID-10 (MVP): Per-connection transaction mode Auto/Manual; in Manual show Commit/Rollback with an uncommitted-change indicator, and warn on tab/connection close with an open transaction.
- REQ-GRID-11 (MVP): Read-only connection flag enforced in grid editing; also enforced at statement level where feasible, since docs show the console may bypass it.
- REQ-GRID-12 (MVP): Multiple result tabs, reuse-vs-new-tab setting, pinning, comment-derived titles (Later for comment titles).
- REQ-GRID-13 (Later): Value editor panel (multi-line, JSON/XML format, LOB load/save, array editing).
- REQ-GRID-14 (Later): Transpose and Tree view; record side panel.
- REQ-GRID-15 (MVP): Selection aggregate bar (count/sum/avg/min/max) for selected cells; Later: pluggable aggregators.
- REQ-GRID-16 (MVP): Copy as TSV/CSV/JSON/SQL INSERT/Markdown for selection; "copy entire result" separate from "copy page" with clear labels (see 07).
- REQ-GRID-17 (Later): FK related-rows navigation; go-to-row; compare results.
- REQ-GRID-18 (MVP): Cancel running query; reload.

## Limitations / not verified

- No live UI capture was made; everything derives from fetched docs (which WebFetch condensed via a summarising model, so wording/precision may be lossy).
- Not covered by fetched docs: pending-change colors/highlighting, column resize, exact default of page size (500 given by rows.html only), Preview Pending Changes shortcut, client-side local-filter scope, conflict-merge applicability to row data, whether Roll Back has a shortcut.
- Shortcut conflicts between pages (delete row) were not resolved.
- Page `exporting-and-importing-data.html` returned only a title. `data-editor-and-viewer.html` was fetched (listed above).
- Keymap assumed Windows/Linux default; macOS/other keymaps not checked.
