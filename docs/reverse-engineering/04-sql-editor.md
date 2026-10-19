# 04 — SQL Editor

## Sources

All fetched 2026-10-19 from the official DataGrip help (documentation labelled 2026.2). Content came through a fetch tool that returns a model-written summary of each page, so wording is paraphrased and details may be lost.

- https://www.jetbrains.com/help/datagrip/query-consoles.html
- https://www.jetbrains.com/help/datagrip/run-a-query.html
- https://www.jetbrains.com/help/datagrip/query-execution.html
- https://www.jetbrains.com/help/datagrip/query-execution-plan.html
- https://www.jetbrains.com/help/datagrip/code-editor.html
- https://www.jetbrains.com/help/datagrip/work-with-sql-code.html
- https://www.jetbrains.com/help/datagrip/viewing-query-results.html
- https://www.jetbrains.com/help/datagrip/auto-completing-code.html
- https://www.jetbrains.com/help/datagrip/sql-dialects.html
- https://www.jetbrains.com/help/datagrip/code-inspection.html
- https://www.jetbrains.com/help/datagrip/code-editor-navigation.html
- https://www.jetbrains.com/help/datagrip/reformat-and-rearrange-code.html
- https://www.jetbrains.com/help/datagrip/configure-the-sql-code-style.html
- https://www.jetbrains.com/help/datagrip/viewing-reference-information.html
- https://www.jetbrains.com/help/datagrip/managing-connection-sessions.html
- https://www.jetbrains.com/help/datagrip/submitting-and-reverting-changes.html
- https://www.jetbrains.com/help/datagrip/schemas.html
- https://www.jetbrains.com/help/datagrip/virtual-foreign-keys.html
- https://www.jetbrains.com/help/datagrip/introspection.html

Fetch failures: `settings-tools-database-query-execution.html` and `settings-sql-resolution-scopes.html` returned HTTP 404. No dedicated "syntax highlighting" or "SQL inspections list" page was fetched, so those topics are thin. Local evidence below is given by the requester, not independently re-read.

## Evidence legend

- [DOC] stated in fetched official docs.
- [CFG] local observation of the user's DataGrip 2026.2.6 on Linux (settings files), as supplied.
- [REA] local observation of the installed product's modules, as supplied.
- [ASSUMPTION] our inference, not verified.

## Observed workflows

1. **Open a query console.** Select a data source and press F4 (default console), or Alt+Insert / Ctrl+Shift+Q / File | New | Query Console for a new one. [DOC]
   - A console is a SQL (or JS) file attached to one data source, stored outside the IDE project in the config `consoles` directory, with one default console created per data source. [DOC]
   - Each console gets a connection session automatically; consoles can share or have separate sessions; the session connects only when something needs the database. [DOC]
   - Console toolbar: schema dropdown (default schema, lets you omit schema names), session switch, transaction mode, execution settings, query history. [DOC]

2. **Execute a statement.** Ctrl+Enter or the Execute button runs the current statement, or the selection if one exists. [DOC]
   - With caret inside a statement, the behaviour is configurable: ask via popup; smallest subquery-or-statement; smallest statement; largest statement; largest statement or batch (T-SQL batch; otherwise same as largest); whole script; everything from caret. [DOC]
   - With caret outside any statement (blank line, comment): do nothing, run whole script, or run everything below. [DOC]
   - With a selection: run exactly as one statement (e.g. a BEGIN...COMMIT block), exactly as separate statements, or "smart expand to script". [DOC]
   - When several statements are candidates, a Statements chooser lists them; the list always includes an all-statements item; Enter runs the chosen one; a Customize link opens settings; running statements are highlighted. [DOC]
   - Whole-file run: "Run <query file>" (Ctrl+Shift+F10). [DOC]
   - Other execute variants: Execute Selection as Single Statement, Execute to File (SELECT output to a chosen export format), Run Function for stored routines with an Execute Routine parameter window. [DOC]

3. **Script splitting.** For Generic and ANSI dialects the splitter can be: valid ANSI statements or by separator (default), ANSI statements only (SQL:2016 grammar), or by separator (semicolon in Generic). The Generic dialect does not report all syntax errors. [DOC]

4. **Resolve modes.** Playground (default for consoles): every statement resolves in the same context. Script (default for local SQL files): a `USE` or `SET search_path TO` statement overrides context. Unqualified names resolve against the schema selector, else the default database. [DOC]

5. **Query parameters.** [DOC]
   - `?` is a parameter in the vendor's syntax; extra patterns are regexes under Database | Query Execution | User Parameters; running prompts for values (Execute or View Parameters button).
   - Positional parameters are numbered by occurrence; named ones reuse the same name for every occurrence, made by adding a capture group `()` to the pattern (examples shown: `\?\w+` and `\?(\w+)`).
   - Arrays can be given as values; "Review parameters before execution" keeps last-used values in memory and shows them before running, or runs immediately when off.
   - [CFG] databaseSettings.xml defines patterns such as `${name}`, `$(name)`, `#name#` (XML), `:'name'` (PostgreSQL), `%(name)s` (Python), i.e. detection by regex scoped per language/dialect.
   - [ASSUMPTION] Scoping patterns per dialect avoids false positives, e.g. `::text` casts or `$1` placeholders in PostgreSQL.

6. **Execution status, timing, results.** [DOC unless noted]
   - Running opens the Services tool window with sessions, an Output tab, and a Result tab per SELECT; tab titled by table, or by a custom title taken from a leading comment (`--` or `/*` by default, configurable).
   - Statements returning no data log to the Output tab, which also records internal queries.
   - "Open results in new tab" off reuses one tab; Pin Tab keeps one; In-Editor Results shows results inside the console (per file or global).
   - "Show query execution time in the editor after completion" keeps the elapsed time displayed on the statement's first line.
   - A notification can fire when a query exceeds 20 seconds ("Database queries that took much time").
   - The docs summaries did not describe a status line with row counts or paging; unverified.

7. **Cancel a query.** Cancel Running Statements (toolbar, gutter progress indicator, Ctrl+F2). A second click shows a warning where the remote process can be terminated or waited on; a warning appears if cancel is idle for 10 s; cancelling during connection setup shows "Connection canceled". Deactivate in the explorer stops DataGrip's side only; the statement may keep running on the server. [DOC]

8. **Transactions.** Transaction mode Auto or Manual (Tx dropdown); Manual needs Commit or Rollback; each session stores its mode. [DOC]
   - Safety: warning before DELETE/UPDATE without WHERE (or WHERE TRUE) — a notification while typing and a confirmation on execute that can still be overridden. [DOC]

9. **Code completion.** Popup appears automatically or on Ctrl+Space; Enter/double-click inserts, Tab replaces the text right of the caret; Ctrl+Shift+Enter completes the statement (parentheses, semicolon). [DOC]
   - SQL-specific: column lists for SELECT/INSERT/GROUP BY; JOIN clauses generated from foreign keys (option to invert ON operand order); OVER() added for window functions; abbreviation matching on camelCase, hyphen and underscore names; DDL name suggestions; alias generation (optional automatic alias on table completion). [DOC]
   - Name-matched joins without FKs: option "Suggest non-strict foreign keys based on name matching"; virtual FKs also feed JOINs. [DOC]
   - ML re-ranking of suggestions (local data, per language). [DOC]
   - Generic dialect still completes keywords, table and column names; dialect-specific completion needs a non-Generic dialect. [DOC]

10. **Dialect and highlighting.** Dialect comes from the data source or schema (manual change only for Oracle); scopes file > project > global; with none set it is Generic, which turns off syntax-error highlighting. Many dialects listed including PostgreSQL, MySQL, SQLite, SQL Server, Oracle, BigQuery, Snowflake, ClickHouse. [DOC] [REA] the product ships per-dialect modules (postgres/postgresbase, mysql/mysqlbase, maria, sqlite, mssql, oracle, clickhouse, snowflake, bigquery, generic, sql92, ...), consistent with dialect layers over a sql92/generic base. [ASSUMPTION] our grammar layering should mirror that (base ANSI + per-dialect overrides).

11. **Inspections and error highlighting.** Inspections are grouped into profiles with severities (Editor | Inspections); SQL ones named in the docs include "Unused subquery item" and "DELETE or UPDATE without WHERE". Unresolved-reference style problems arise when objects are not introspected. [DOC] Quick-fix on Alt+Enter exists (e.g. "Store table relation" on an ON clause). [DOC, from the virtual FK page]

12. **Formatting.** Ctrl+Alt+L reformats selection or whole file; Ctrl+Alt+Shift+L reformats the open file; Ctrl+Alt+I fixes line indents; `@formatter:off` / `@formatter:on` comment markers exclude regions (must be enabled on the Formatter tab); reformat on save under Tools | Actions on Save; per-dialect schemes under Editor | Code Style | SQL (Case, Queries, DDL, Code, Expressions, Tabs and Indents, Wrapping, Code Generation); presets Modern, Joe Celko Allman, Whitesmiths, Egypt, Old Idea; assignable per data source; "Disable formatting" checkbox. [DOC]

- [CFG] the user's editor.xml has REFORMAT_ON_PASTE=1, so pasted code is reformatted on paste in this install. The fetched reformat page says nothing about paste, so the setting's UI location is unverified.

13. **Explain plan.** Explain Plan (planning only) and Explain Analyse (executes the statement, reports run-time stats in ms, only on databases that support it) from the editor toolbar dropdown or context menu; result on a Query Plan tab as mixed tree/table, diagram (Ctrl+Alt+Shift+U), flame graph (total or startup cost), raw output, and Copy Original Query Plan (PostgreSQL, Redshift, MySQL, MariaDB, Oracle, SQL Server, Snowflake). Costs are relative planner units (startup vs total). [DOC]

14. **Navigation and references.** Ctrl+B on a name opens its DDL; Alt+Shift+B goes to definition of a reference; Ctrl+Q shows Quick Documentation (table definition and preview in the case of tables); Query History dialog Ctrl+Alt+E lists past console statements, type to filter, double-click to paste. [DOC]

## Keyboard shortcuts

| Action                                | Windows/Linux      | Source |
| ------------------------------------- | ------------------ | ------ |
| Execute statement / selection         | Ctrl+Enter         | [DOC]  |
| Run whole query file                  | Ctrl+Shift+F10     | [DOC]  |
| Cancel running statements             | Ctrl+F2            | [DOC]  |
| New query console                     | Ctrl+Shift+Q       | [DOC]  |
| Open default console from data source | F4                 | [DOC]  |
| Basic completion                      | Ctrl+Space         | [DOC]  |
| Complete current statement            | Ctrl+Shift+Enter   | [DOC]  |
| Quick documentation                   | Ctrl+Q             | [DOC]  |
| Parameter info                        | Ctrl+P             | [DOC]  |
| Type info                             | Ctrl+Shift+P       | [DOC]  |
| Go to DDL / declaration               | Ctrl+B             | [DOC]  |
| Go to definition of reference         | Alt+Shift+B        | [DOC]  |
| Reformat code                         | Ctrl+Alt+L         | [DOC]  |
| Query history                         | Ctrl+Alt+E         | [DOC]  |
| Comment line                          | Ctrl+/             | [DOC]  |
| Duplicate / delete line               | Ctrl+D / Ctrl+Y    | [DOC]  |
| Move statement                        | Ctrl+Shift+Up/Down | [DOC]  |
| Show diagram of plan                  | Ctrl+Alt+Shift+U   | [DOC]  |

## Edge cases and error states

- Caret on blank line or comment: behaviour depends on setting (nothing / whole script / below). [DOC]
- Selection spanning statement boundaries: three documented modes; "as single statement" keeps a transaction block intact. [DOC]
- Files over 20 MB are not fully loaded; larger files show only the first 2.5 MB. [DOC]
- Generic dialect suppresses syntax errors, so a wrong dialect hides real errors. [DOC]
- Unresolved objects when schema not introspected, or when resolve mode/context differs. [DOC]
- Cancel may not stop server-side work (Deactivate); double-cancel offers remote termination. [DOC]
- Explain Analyse has real side effects for DML. [DOC]
- Editing multi-table JOIN result cells opens DML Preview; not possible for UNION, self-joins, calculated columns. [DOC]
- Stale cache after DDL run in console depends on Auto sync. [DOC, from file 03 sources]
- Completion popup may not appear under heavy load or Power Save Mode; Ctrl+Space forces it. [DOC]

## Implementation requirements for our app

Design target: Monaco Editor in the React/Tauri frontend, Rust backend, PostgreSQL first.

- REQ-EDIT-01 (MVP) Query console per connection, persisted as files in app data dir; tab titles; multiple consoles per connection; each bound to one backend session.
- REQ-EDIT-02 (MVP) Monaco with PostgreSQL syntax highlighting (Monarch or tree-sitter tokenizer) and a dialect abstraction (base ANSI + dialect overrides) so other engines slot in later.
- REQ-EDIT-03 (MVP) Statement detection in Rust (handles `;`, quoted strings, dollar-quoted `$$...$$` bodies, comments); Ctrl+Enter runs selection, else statement at caret; separate Run Script command.
- REQ-EDIT-04 (MVP) Setting for caret-outside-statement and multi-statement selection behaviour, with a chooser popup option; default: run statement under caret.
- REQ-EDIT-05 (MVP) Execution status: running indicator, elapsed time next to statement, row count or affected rows, error message with position; long-query (>20 s) notice.
- REQ-EDIT-06 (MVP) Cancel via backend `pg_cancel_backend`-style request on a second connection; fall back to dropping the session; UI shows "cancelling" then final state.
- REQ-EDIT-07 (MVP) Completion provider fed by cached catalog: keywords, schemas, tables, columns, aliases in scope, functions; JOIN suggestions from foreign keys; fuzzy and abbreviation matching.
- REQ-EDIT-08 (MVP) Unsafe-statement guard for UPDATE/DELETE without WHERE with confirmation.
- REQ-EDIT-09 (MVP) Transaction mode toggle (auto / manual with Commit and Rollback and visible pending-tx indicator).
- REQ-EDIT-10 (MVP) Named and positional parameter prompt: configurable per-dialect regexes (defaults for `:name`, `${name}`, `$1`), values remembered per console; skip inside strings and comments.
- REQ-EDIT-11 (MVP) Schema resolution: console default schema selector and PostgreSQL search_path awareness for resolving unqualified names.
- REQ-EDIT-12 (Later) Formatter (Rust or WASM) with style schemes, selection formatting, `@formatter:off` markers, optional format on paste (we need to decide default; the reference user enables it [CFG]).
- REQ-EDIT-13 (Later) Inspections: unresolved table/column, missing WHERE, unused CTE columns; severity styling via Monaco markers.
- REQ-EDIT-14 (Later) EXPLAIN / EXPLAIN ANALYZE with tree view, raw JSON, cost columns; warn that ANALYZE executes.
- REQ-EDIT-15 (Later) Script vs playground resolve modes; Execute to file; query history with filter; go-to-definition from a name to DDL; hover docs.
- REQ-EDIT-16 (Later) Resolve-mode and dialect switch per console, auto from connection type.

## Limitations / not verified

- No live UI capture was made; all [DOC] items rest on summarised help text, not screenshots or behaviour tests.
- Not obtained: the Query Execution settings page and SQL resolution scopes page (404); dedicated syntax-highlighting and SQL-inspection-list pages; the exact shape of the status line (row counts, paging); default values of most execution checkboxes.
- Default of the "what to execute" popup, exact popup labels, and timing-display format were not confirmed.
- The [CFG]/[REA] items were supplied by the requester and not re-read here; REFORMAT_ON_PASTE's UI location is unconfirmed.
- Completion ranking details, abbreviation algorithm, and parser internals are undocumented, so REQ-EDIT items are our designs.
