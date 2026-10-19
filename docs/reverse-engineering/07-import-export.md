# 07 — Import / export

## Sources

All fetched 2026-10-19 (WebFetch returns a model-generated summary, not raw HTML).

- https://www.jetbrains.com/help/datagrip/import-data.html
- https://www.jetbrains.com/help/datagrip/import-from-excel-files.html
- https://www.jetbrains.com/help/datagrip/data-loaders.html
- https://www.jetbrains.com/help/datagrip/data-extractors.html
- https://www.jetbrains.com/help/datagrip/export-data.html
- https://www.jetbrains.com/help/datagrip/editing-csv-and-tsv-files.html
- https://www.jetbrains.com/help/datagrip/table-editor.html
- https://www.jetbrains.com/help/datagrip/rows.html
- https://www.jetbrains.com/help/datagrip/settings-tools-database-data-views.html
- https://www.jetbrains.com/help/datagrip/run-a-query.html
- https://www.jetbrains.com/help/datagrip/exporting-and-importing-data.html (fetched, but the result contained only the page title; no usable content)

## Evidence legend

- [DOC] stated in fetched official JetBrains docs.
- [CFG] local observation of the user's DataGrip 2026.2.6 options (csvSettings.xml, scripted-loader associations, shipped grid modules).
- [REA] local static inventory evidence (not relevant to import/export here).
- [ASSUMPTION] our inference, not verified.

## Observed workflows

1. **Start an import (menu).** Database Explorer -> right-click schema or table -> Import/Export -> "Import Data from File(s)" -> choose file(s) -> Import dialog [DOC]. Importing into a schema creates a new table; importing into a table appends rows [DOC].
2. **Start an import (drag and drop).** Drag a file from the Files tool window (Alt+2) onto a schema/table in Database Explorer; the directory must be attached to the project [DOC].
3. **Import dialog layout.** Upper-left mapping tree (file-to-table, table-to-table, query-to-table nodes); upper-right source settings for the selected file; bottom preview pane with "Data Preview" and "DDL Preview" [DOC].
4. **Target and column mapping.** Select the mapping node -> pick target Schema and Table (existing or new); "Auto Generate" fills a table name; an edit icon creates a new table in-dialog [DOC]. Mapping grid pairs Source Column with Target Column; Add / Remove / Up / Down manage ordering; per-column target type can be edited (e.g. varchar(2), numeric in the Excel example) [DOC].
5. **CSV/DSV source settings.** Path; Charset; Format (edit icon opens the CSV format editor); "First row is header"; "First column is header"; "Trim whitespaces"; a column list showing source name/type [DOC]. CSV is handled by data extractors; other tabular formats by scripted loaders [DOC].
6. **CSV formats.** Built-in: CSV, TSV, Pipe-separated; extra formats can be created, copied, reordered via "Configure CSV Formats" [DOC]. Format fields: value separator, row separator, null value text, row prefix/suffix, quotation patterns (left quote, right quote, escape method incl. duplicate-the-quote; first pattern is used if several), "Quote values" Never / When needed / Always, trim whitespaces, first-row/first-column header [DOC]. Preview shows up to 10 records and live-updates [DOC].
   - [CFG] The installed IDE defines four formats: CSV (","), TSV (tab), Pipe-separated ("|"), Semicolon-separated (";"). All use nullText "" (empty), quotation policy "as needed", newline record separator, and quote pairs `"` (escaped by doubling `""`) and `'` (escaped by doubling `''`).
   - [CFG] Pipe-separated and Semicolon-separated exist in settings, though the docs only name CSV/TSV/Pipe-separated as predefined [DOC vs CFG difference].
7. **Tabular (non-CSV) files.** Excel (.xlsx/.xls), JSON, Parquet, Shapefile (.shp) via scripted loaders; dialog shows a "Loader" picker, "First row is header", and column name/type settings, but not the First-column or Trim options [DOC]. Excel opens as table by default; JSON as table is off by default and enabled via the Advanced Settings option "Open file as table if detected by scripted loader" [DOC]. Loaders are Groovy scripts under Scratches and Consoles > Extensions > Database Tools and SQL > data > loaders, with a header line (extensions, displayName, tableFirstFormat) and a DataConsumer API (consumeColumns, consume row) [DOC].
   - [CFG] The installed IDE lists json, parquet, shp, xls, xlsx as loadable extensions, and ships grid.csv, grid.json, grid.charts, grid.images, grid.scripting modules plus grid-loader-json and grid-loader-xls plugins.
8. **Preview.** "Data Preview" (source) shows how the file parses with the current settings (Reload Page refreshes; Modify Source jumps back to settings); "Data Preview" (target) shows data as it will be imported; "DDL Preview" shows the CREATE statements, which can be edited before applying [DOC].
9. **Import options.** Encoding; "Write errors to file" (text log of import errors); "Insert inconvertible values as null"; "Disable indexes and triggers, lock table" (shown only if the target has indexes/triggers; triggers may not fire) [DOC]. A dedicated "text that means NULL" import setting is not on the import page; null text lives in the CSV format definition [DOC].
10. **Open DSV file as an editable table.** Files tool window or Edit as Table -> choose format (CSV/TSV/Pipe/custom) -> Text/Data tabs switch views; a selection can be edited alone [DOC]. Saving edits back to the file is not described [DOC, absence].
11. **Export data to file (explorer).** Right-click objects -> Import/Export -> "Export Data to File" -> dialog with Extractor, Transpose, Add column header, Add row header, Output file; buttons Copy to Clipboard / Export to File. Settings vary by extractor [DOC]. One file per table/view [DOC].
12. **Export from grid.** "Export Data" toolbar icon exports the whole result/table to file or clipboard; "Export Table to Clipboard" copies the whole table with the current extractor, ignoring the page limit; Ctrl+C copies selected rows on the page; Ctrl+A+Ctrl+C copies the page [DOC]. "Skip Computed/Generated Columns" in the extractor menu [DOC].
13. **Extractors.** SQL Inserts, SQL Updates, Where Clause; CSV, TSV, Pipe-separated; scripted: CSV, TSV, Excel (.xlsx/.xls), HTML, JSON, Markdown, One-row, SQL-Insert-Multirow, SQL-Insert-Statements, Pretty (.txt), XML [DOC]. Last-used becomes default for new tabs; MongoDB defaults to JSON [DOC]. Custom extractors: Groovy/JS files named `Name.output.extension` in the extractors folder, with bindings DIALECT, TABLE, ALL_COLUMNS, COLUMNS, FORMATTER, OUT, ROWS, TRANSPOSED [DOC].
14. **SQL-file export options.** "Add column" (computed/generated column code), "Add table definition (DDL)", "Output query to a separate sheet" (xlsx) [DOC].
15. **Execute to File.** Right-click a SELECT -> Execute to File -> choose output format [DOC (run-a-query summary)].
16. **DDL export.** SQL Generator (Ctrl+Alt+G) with output layouts: file per object; per object with order; per schema; per schema and database; per schema and type; copy DDL to clipboard/console; MySQL option to skip DEFINER [DOC].
17. **Dumps.** Right-click -> "Export with 'mysqldump'" / "Export with 'pg_dump'"; requires the tool on the same workstation, runs locally or in Docker (Docker plugin), WSL paths supported [DOC]. mysqldump options: databases/tables, DROP before CREATE, disable keys, lock tables, add locks, no data, no tablespaces, no table creation, complete inserts, create options, routines, extended insert, delayed insert [DOC]. pg_dump options: COPY / INSERT / INSERT with columns, database/schemas/tables, format p/d/c/t, path, clean, if exists, create database, data only [DOC]. SQL Server uses external `bcp` (path + target file + Run) [DOC]. MongoDB: JSON extractor produces Extended JSON [DOC]. A matching "restore" path is mentioned only via the Docker plugin note on the import page [DOC, thin].
18. **Copy to Database / Compare Data.** Toolbar actions in the grid to copy to another table/schema/database [DOC].

## Keyboard shortcuts

| Action                                 | Windows/Linux   | Source         |
| -------------------------------------- | --------------- | -------------- |
| Copy selected rows (current extractor) | Ctrl+C          | [DOC]          |
| Select all rows on page, then copy     | Ctrl+A, Ctrl+C  | [DOC]          |
| Paste (CSV lines onto rows)            | Ctrl+V          | [DOC]          |
| Open Files tool window                 | Alt+2           | [DOC]          |
| SQL Generator (DDL export)             | Ctrl+Alt+G      | [DOC]          |
| Import / Export Data menu items        | none documented | [DOC, absence] |

## Edge cases and error states

- Import errors can be written to a text file; inconvertible values can become NULL instead of failing [DOC]. Behavior without either option (abort vs skip) is not stated [not documented].
- Disabling triggers/indexes during import may skip trigger side effects [DOC].
- Exported files are one per table/view [DOC]; Ctrl+C is limited to the current page while Export is not [DOC].
- Dump tools are external; not integrated for bcp, and DataGrip must be on the same host as mysqldump/pg_dump [DOC].
- Delimited preview is capped at 10 records, so format problems deeper in a file will not show [DOC].
- Docs state "first pattern is used" for multiple quote patterns [DOC]; round-trip fidelity of null vs empty string depends on nullText ("" by default [CFG]) so NULL and empty string are indistinguishable in default CSV [ASSUMPTION, derived from CFG].
- Scripted-loader failures and unsupported types are not described [not documented].

## Implementation requirements for our app

- REQ-IMPEX-01 (MVP): Import wizard for CSV/TSV (and pipe/semicolon presets) from a file picker and drag-and-drop onto a schema/table.
- REQ-IMPEX-02 (MVP): Format settings: delimiter, quote char, escape (double-quote vs backslash), record separator, header row yes/no, trim, encoding (UTF-8 default with detection), null token (default empty), configurable per import, with saved presets.
- REQ-IMPEX-03 (MVP): Target selection: existing table (append) or new table in a chosen schema, with editable table name.
- REQ-IMPEX-04 (MVP): Column mapping grid: source column -> target column, ignore column, reorder, type override for new tables; type inference from a sample with user edit.
- REQ-IMPEX-05 (MVP): Preview of the first N parsed rows and the generated DDL (editable) before any write; nothing is written until the user confirms.
- REQ-IMPEX-06 (MVP): Error handling policy chooser: abort on first error / skip bad rows and log / insert unconvertible values as NULL; error log file or in-app list with line numbers; run inside one transaction by default so abort leaves no partial rows.
- REQ-IMPEX-07 (MVP): Export from result grid and from tables: formats CSV, TSV, JSON, SQL INSERT, Markdown; options for header row, transpose (Later), NULL text, quoting policy; destination file or clipboard; "selected / page / full result" scopes are explicit and labelled.
- REQ-IMPEX-08 (MVP): Full-export of a result re-runs the query without the page limit with streaming to disk and a cancel control.
- REQ-IMPEX-09 (Later): Excel (.xlsx), Parquet, JSON-lines import; extension point for custom extractors/loaders (sandboxed; our own API).
- REQ-IMPEX-10 (Later): mysqldump/pg_dump front-end: build a command from options, run local binary, stream output, never embed credentials in logged command lines.
- REQ-IMPEX-11 (Later): Option to disable triggers/indexes during bulk import, with an explicit warning about skipped triggers.
- REQ-IMPEX-12 (MVP): Large-file handling: stream-parse, bounded memory, progress and cancel.

## Limitations / not verified

- No live UI capture was made. The docs were read through a summarising fetch tool, so exact labels may differ slightly from the IDE.
- Not covered by fetched docs: default import error behavior, null-text handling on import beyond the CSV format field, type-inference rules, Excel sheet selection, scripted loader failure modes, restore tooling, keyboard shortcuts for import/export commands.
- The `exporting-and-importing-data.html` overview returned no content, so cross-feature overview text is not available.
- [CFG] is a static read of local options files, not observed runtime behavior; the pipe/semicolon presets were not confirmed in docs beyond Pipe-separated.
