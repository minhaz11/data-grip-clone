# 08 — History, Consoles, Environments and Transactions

## Sources

All fetched 2026-10-19 from official JetBrains DataGrip help (relayed through the fetch tool's summarising step).

- https://www.jetbrains.com/help/datagrip/query-consoles.html
- https://www.jetbrains.com/help/datagrip/working-with-files.html
- https://www.jetbrains.com/help/datagrip/scratches.html
- https://www.jetbrains.com/help/datagrip/files-tool-window.html
- https://www.jetbrains.com/help/datagrip/find-recent-queries-and-files.html
- https://www.jetbrains.com/help/datagrip/run-a-query.html
- https://www.jetbrains.com/help/datagrip/query-execution.html
- https://www.jetbrains.com/help/datagrip/viewing-query-results.html
- https://www.jetbrains.com/help/datagrip/code-editor.html
- https://www.jetbrains.com/help/datagrip/store-your-queries.html
- https://www.jetbrains.com/help/datagrip/using-live-templates.html
- https://www.jetbrains.com/help/datagrip/services-tool-window.html
- https://www.jetbrains.com/help/datagrip/sessions.html
- https://www.jetbrains.com/help/datagrip/submitting-and-reverting-changes.html
- https://www.jetbrains.com/help/datagrip/configuring-database-connections.html
- https://www.jetbrains.com/help/datagrip/data-sources-and-drivers-dialog.html
- https://www.jetbrains.com/help/datagrip/managing-data-sources.html
- https://www.jetbrains.com/help/datagrip/database-explorer.html
- https://www.jetbrains.com/help/datagrip/faq-about-datagrip.html

Fetch attempts that returned HTTP 404 (not used): transaction-control.html, query-history.html, database-color-settings-dialog.html (404 twice), attach-a-file-to-a-data-source.html, switching-between-schemas.html, running-sql-queries.html.

## Evidence legend

- [DOC] stated in fetched official docs.
- [CFG] observed in the user's local DataGrip 2026.2.6 config on Linux.
- [ASSUMPTION] our inference, not verified.

## Observed workflows

1. **Query console lifecycle.** A console is created automatically with each data source and attached to it; more can be made via File | New | Query Console, right-click New | Query Console, Alt+Insert | Query Console, Ctrl+Shift+F10 | New Query Console, or Ctrl+Shift+Q [DOC]. Consoles are SQL/JS files, always attached to their data source, kept outside the project context [DOC]. On disk they live in the `consoles` subdirectory of the IDE config dir [DOC]; locally observed as consoles/db/<data-source-uuid>/console.sql, console_1.sql, console_2.sql (file names only) [CFG]. Reopen via Files window | Scratches and Consoles | Database Consoles | <data source>, Explorer "Jump to Query Console", or F4 on a data source [DOC]. Persistence across restarts is not explicitly stated in the page, though they are files [DOC]. After restart the session list in Services reappears empty [DOC].
2. **Console naming and organisation.** Default file name and tab-title template configurable under Database | Query Files and Consoles [DOC]; rename via tab context menu or Shift+F6 [DOC]; subdirectories under a data source group with drag-to-move [DOC]; Duplicate from tab/editor context menu (consoles only) [DOC]; copy via Refactor | Copy File [DOC]; delete via Files window [DOC]. Console tab titles are shortened to 36 characters by default (Shorten Tab Titles on tab menu) [DOC]. Hovering a tab shows its path [DOC].
3. **File kinds compared.** Query file: SQL/JS, attachable and detachable, may live in or outside a project, VCS-able, default resolve mode Playground. Query console: SQL/JS bound to one data source, outside project, Playground. Scratch file: temporary notes/drafts outside the project, not attached by default, default resolve mode Script, can be attached to act as an SQL editor. User file: SQL script on disk or server, project-attachable, not attached by default, Script mode. Object editor: internal files for editing DDL of procedures/views/functions [DOC, working-with-files].
4. **Scratch files and buffers.** Create with Ctrl+Alt+Shift+Insert, File | New | Scratch File, or the Files window add button; choose dialect [DOC]. Create from a selection via Alt+Enter [DOC]. Stored in the config dir under `scratches` (Linux: ~/.config/JetBrains/<product><version>), relocatable via the `idea.scratch.path` property [DOC]. Available from any project using the same IDE config [DOC]. Closing an empty scratch deletes it [DOC]. Scratch buffers: plain text, max five (buffer1..5), renamed buffers are protected from clearing [DOC]. Attach to a data source via the data source list in the upper right or by running with Ctrl+Enter and choosing one [DOC].
5. **Attached files.** Query/user files get a data source from the `<data source>` selector; once attached, objects resolve and navigation works; a `<schema>` selector appears only after a session is attached [DOC]. Context menu offers Attach Data Source / Switch Data Source; toolbar "Switch attached data source" is for query files only [DOC]. For correct resolution of user files, map them in Settings | Database | SQL Resolution Scopes [DOC]. Directories can be attached to the project via Attach Directory to Project; files are indexed so they are findable by name and content [DOC].
6. **Resolve modes.** Playground (default for consoles): every object resolves to one context, for unrelated statements. Script (default for local SQL files): a `USE` (or `SET search_path TO` in PostgreSQL) statement overrides the context [DOC].
7. **Query history.** Per data source; lists statements run in consoles; open with the "Browse Query History" toolbar button or Ctrl+Alt+E; type to filter, double-click to paste into the editor, Delete removes a record [DOC]. The dialog title is "<data source> Query History" [DOC]. Retention limit and filters beyond text search are not documented [DOC].
8. **Other history layers.** Local History per file: right-click editor | Local History | Show History; search revisions and copy fragments from a diff; works on directories to restore deleted files (Revert Selection) [DOC]. SQL log of everything DataGrip itself runs: database.log, opened via Help | Show SQL Log [DOC]. Recent files and consoles popup Ctrl+E [DOC]. Clipboard history Ctrl+Shift+V (session-scoped, default limit 100) [DOC].
9. **Live templates.** Abbreviation + Tab expands; Tab/Shift+Tab move between variables [DOC]. Types: simple, parameterized (`$name$`, `$$` for a literal dollar), surround [DOC]. Edited in Settings | Editor | Live Templates, grouped by language (SQL), restrictable to a dialect, abbreviations unique per group, expansion key Tab/Enter/Space, optional reformat on insert; create from code via Save as Live Template; Ctrl+J lists applicable templates [DOC]. Postfix completion example `.cfrom` [DOC]. FAQ mentions a `sel` template giving a SELECT * FROM skeleton [DOC]. User parameters inside templates prompt before execution [DOC].
10. **Other ways to store queries.** Virtual views (named SELECT saved under a schema), live templates, attached SQL file directories, Database Script run configurations [DOC].
11. **Colors / marking environments.** Docs offer color marking, not a dedicated "production" flag: the FAQ says to mark data sources by color via Ctrl-click then Set Color [DOC]. Set Color options: Auto (inherit), No Color, named colors, Custom hue, Apply to Children for folders [DOC]. Name dialog has a color circle [DOC]. Where colors display is set in Settings | Database | Database Explorer ("Show database colors") [DOC]. Whether colors also tint editor tabs, grids and toolbars and can be shared via VCS comes from a search-result summary of a page that we could not fetch; treat as unverified [ASSUMPTION]. File-scope colors (e.g. production vs test scopes) are also described for the Files tree, search results and editor tabs [DOC, files-tool-window].
12. **Read-only.** Options tab checkbox; blocks edits in the data editor; consoles may still permit edits if the driver does not support read-only [DOC]. The docs present it separately from color; combine them for a production marker [ASSUMPTION].
13. **Transaction control.** Per data source Options | Transaction control Auto or Manual, with DBMS-dependent isolation levels; driver-level default exists [DOC]. In the Services toolbar and console toolbar a "Transaction Mode and Isolation" control sets it; Commit and Roll back buttons appear only in Manual mode [DOC]. Auto commits when local changes are submitted; Manual accumulates until committed or rolled back [DOC]. Tx:Auto changes cannot be rolled back after submit [DOC]. Data editor has a Tx drop-down; "Submit changes immediately" setting exists (Database | Data Editor and Viewer) [DOC]. Submit Ctrl+Enter; Submit and Commit Ctrl+Alt+Shift+Enter; Preview Pending Changes shows DML; Revert Selected Ctrl+Alt+Z [DOC]. Output tab logs autocommit mode per run [DOC]. Session state includes the transaction mode, set via Tx Mode in the session context menu [DOC]. A search-result summary mentioned a newer "Transparent" mode in an EAP; not verified from a fetched page [ASSUMPTION].
14. **Switch schema / session for a console.** Toolbar "Switch current schema" sets default database/schema; for PostgreSQL, Redshift and Greenplum the list builds the search path [DOC]. Options | Switch schema: Automatic (restored between restarts), Manual, Disable [DOC]. Consoles can share one session or use separate ones; attach/new session from the console toolbar; in Services use Switch Session to move a client to another session [DOC]. Session control modes: Single shared, Two sessions (introspection + shared), Dedicated; each new console opens a new connection under Dedicated [DOC]. Internal sessions can be shown via Database | Query Execution | Output and Results [DOC]. Snowflake has role/warehouse selector; Oracle/Db2 have DBMS_OUTPUT toggle [DOC].
15. **Running and results.** Execute behaviour is governed by Query Execution settings (caret-in-statement, caret-outside, selection, script splitting) [DOC]. Results tab titles can derive from a comment before the query [DOC]. In-editor results toggle per file or globally [DOC]. Notification for queries running over 20 seconds is optional [DOC]. Slow cancel: second Cancel shows a warning to terminate the remote process or wait [DOC]. Deactivate stops client-side only; the query may continue on the server [DOC]. Review-parameters-before-execution and unsafe DELETE/UPDATE-without-WHERE warning are toggles [DOC].

## Keyboard shortcuts

| Action                                         | Windows/Linux                       | Source |
| ---------------------------------------------- | ----------------------------------- | ------ |
| New query console                              | Ctrl+Shift+Q (data source selected) | [DOC]  |
| Jump to Query Console                          | Ctrl+Shift+F10                      | [DOC]  |
| Open default console                           | F4                                  | [DOC]  |
| New scratch file                               | Ctrl+Alt+Shift+Insert               | [DOC]  |
| Execute                                        | Ctrl+Enter                          | [DOC]  |
| Browse Query History                           | Ctrl+Alt+E                          | [DOC]  |
| Recent files and consoles                      | Ctrl+E                              | [DOC]  |
| Clipboard history                              | Ctrl+Shift+V                        | [DOC]  |
| Cancel running statements / Deactivate         | Ctrl+F2                             | [DOC]  |
| Run query file                                 | Ctrl+Shift+F10                      | [DOC]  |
| Rename file                                    | Shift+F6                            | [DOC]  |
| Submit / Submit and Commit                     | Ctrl+Enter / Ctrl+Alt+Shift+Enter   | [DOC]  |
| Revert selected                                | Ctrl+Alt+Z                          | [DOC]  |
| Expand live template next/previous variable    | Tab / Shift+Tab                     | [DOC]  |
| List live templates                            | Ctrl+J                              | [DOC]  |
| Select In (locate console in Files / Explorer) | Alt+F1                              | [DOC]  |

## Edge cases and error states

- Console files live outside the project: deleting a data source or config does not obviously remove them; docs do not describe orphan handling [DOC gap].
- Query history is only reachable through the UI (support-forum statement not fetched; unverified) and its limit is not documented.
- Scratch buffer cycle: sixth buffer reuses buffer1 and asks to clear it unless renamed [DOC].
- Empty scratch is deleted when its tab closes [DOC].
- A SQL file with no data source cannot run until one is chosen [DOC]. Files must be the SQL file type; files over 20 MB load only the first 2.5 MB [DOC].
- Read-only: edits may still succeed from a console if the driver ignores the flag [DOC].
- Manual transaction mode leaves uncommitted changes until Commit/Roll back; those buttons are hidden in Auto [DOC]. Commit button state is session-specific [DOC].
- Changing session control disconnects sessions after confirmation [DOC].
- Only schemas selected for introspection resolve in a console [DOC].
- Cancelling twice warns; idle cancel warns after 10 seconds [DOC].
- Resolve mode difference means the same `USE` statement is ignored in Playground consoles but honoured in Script files [DOC].
- Positional vs named user parameters share values differently (named share one value per name) [DOC].

## Implementation requirements for our app

- REQ-CONSOLE-01 (MVP): Each connection owns a default console; users can add, rename, duplicate, delete consoles; console text persisted as plain files under an app data dir keyed by connection id (our layout, e.g. consoles/<connection-id>/<name>.sql).
- REQ-CONSOLE-02 (MVP): Console tab shows connection name/color and current schema; file path tooltip.
- REQ-CONSOLE-03 (MVP): Scratch files not bound to a connection; "attach to connection" action; quick-create shortcut.
- REQ-CONSOLE-04 (Later): Attach directories of .sql files, index for search, "locate in file tree" action.
- REQ-CONSOLE-05 (Later): Resolve modes (playground vs script) affecting identifier resolution and `USE` handling.
- REQ-HIST-01 (MVP): Per-connection query history store (SQLite): statement text, timestamp, duration, status/error, rows affected, session id; searchable popup, insert-into-editor, delete entry.
- REQ-HIST-02 (MVP): Retention policy configurable (count and age) because the reference docs give none; export history to file.
- REQ-HIST-03 (MVP): Per-file local revision history with diff restore.
- REQ-HIST-04 (Later): Execution log view of internal metadata queries.
- REQ-SNIP-01 (Later): Live templates: abbreviation, variables, dialect scope, expansion key, import/export, `$` escaping.
- REQ-ENV-01 (MVP): Connection color/label (e.g. production/staging/dev) applied consistently to tree node, console tabs and grid header; inheritable from folder.
- REQ-ENV-02 (MVP): Read-only flag per connection with prominent badge; for "production" labelled connections offer a confirm-before-run option for write statements. This extends, not copies, the reference behaviour.
- REQ-TX-01 (MVP): Per-session transaction mode (auto/manual) with isolation selector; commit/rollback buttons visible only in manual mode; pending-transaction indicator and warn on close/disconnect.
- REQ-TX-02 (MVP): Default transaction mode set at connection level and applied to new consoles; log the mode on each execution.
- REQ-SESS-01 (MVP): Session control: shared vs dedicated session per console; switch session action; per-console current schema selector (search path for Postgres) with restore on restart option.
- REQ-SESS-02 (MVP): Cancel running statement with escalation to server-side cancel; Deactivate disconnects and warns that server queries may continue.
- REQ-EXEC-03 (MVP): Configurable execution target (caret statement / selection / script), unsafe-statement warning, parameter prompts.

## Limitations / not verified

- No live UI capture of DataGrip was made; all items come from fetched help text relayed through a summarising tool.
- The dedicated transaction-control page, query-history page, attach-file page, schema-switching page and color-settings page returned 404, so isolation-level lists, history retention, color propagation to editor/grid areas and VCS sharing of colors are not confirmed from fetched sources.
- The docs do not define a named "environment" or "production" concept; they only document colors and the read-only flag.
- Persistence of consoles across restarts and their relation to scratch files beyond location/context was not explicitly documented; [CFG] shows console files on disk with only file names observed. The role of dataSourcesHistory/data_sources_history.xml is unknown.
- Statements about a newer "Transparent" transaction mode, query-history access limits and color sharing originated only from search-result summaries and are not treated as documented facts.
- Exact UI labels, default option values (e.g. default execute behaviour) were not stated in the fetched pages.
