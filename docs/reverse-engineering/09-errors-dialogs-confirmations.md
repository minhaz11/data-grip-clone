# 09 — Errors, dialogs, confirmations

## Sources

All fetched 2026-10-19 (WebFetch returns a model-generated summary, not raw HTML).

- https://www.jetbrains.com/help/datagrip/query-execution.html
- https://www.jetbrains.com/help/datagrip/run-a-query.html
- https://www.jetbrains.com/help/datagrip/services-tool-window.html
- https://www.jetbrains.com/help/datagrip/code-inspection.html
- https://www.jetbrains.com/help/datagrip/using-code-editor.html
- https://www.jetbrains.com/help/datagrip/connectivity-problems.html
- https://www.jetbrains.com/help/datagrip/data-sources-and-drivers-dialog.html
- https://www.jetbrains.com/help/datagrip/configuring-database-connections.html
- https://www.jetbrains.com/help/datagrip/introspection.html
- https://www.jetbrains.com/help/datagrip/database-explorer.html
- https://www.jetbrains.com/help/datagrip/submitting-and-reverting-changes.html
- https://www.jetbrains.com/help/ai-assistant/find-and-fix-problems-with-ai.html
- Search-only (result snippets read via WebSearch, pages NOT fetched, so treat as weak): jetbrains.com/help/datagrip/reporting-connection-issues.html, youtrack DBE-1456. They are not used for [DOC] claims below except where marked.

## Evidence legend

- [DOC] stated in fetched official JetBrains docs.
- [CFG] / [REA] local observation: [REA] static inventory of intellij.database.ai.jar (see file 10); no other local evidence applies here.
- [ASSUMPTION] our inference, not verified.

## Observed workflows

1. **Query fails -> where the error shows.** Statements and errors from a console are logged in the Services tool window Output tab, with timestamps, affected rows, duration and autocommit mode; toolbar has Soft-Wrap, Scroll to End, Print, Clear All; context menu offers Copy, Pause Output, Clear All, fold-similar-lines [DOC]. The docs do not describe a dedicated error view; errors appear in the Output log [DOC]. Query History (Ctrl+Alt+E) lists past statements [DOC].
2. **AI actions on a failed query.** An error message area offers "Explain with AI" and "Fix with AI" (from 2024.3); Explain opens AI Chat with an auto-sent prompt; Fix generates a corrected query in the editor and asks "Do you like the generated result?" Yes/No [DOC, AI Assistant page]. Attaching the schema may improve results [DOC]. (Details in file 10.)
3. **Error position in the editor.** Problems are highlighted by severity; the scrollbar shows stripes (red for errors up to blue for TODO), hovering shows a tooltip, clicking jumps; the Inspections widget summarises and opens the Problems tool window; F2 / Shift+F2 move to next / previous error; Ctrl+F1 shows the description at the caret; Alt+click copies tooltip text (Ctrl+Alt+click on Linux) [DOC]. How a server-reported error line/column inside a console statement is mapped to a highlight is not described [not documented].
4. **Destructive-statement warning.** While typing, a DELETE or UPDATE lacking a WHERE (or with WHERE TRUE) gets an inline notification [DOC]. On run, a warning appears; if intentional, clicking "Execute" in the warning runs it [DOC]. Controlled by Settings > Database > Query Execution > "Show warning before running potentially unsafe queries" [DOC]. This is also a code inspection ("Delete or update statement without where clauses") with severity profiles [DOC]. Options of that inspection (skip when LIMIT or conditional JOIN exists) come from search snippets only [not fetched].
5. **No production-tag confirmation.** The fetched docs describe no "production environment" confirmation dialog. Documented safeguards are: data source Read-only checkbox (blocks edits in the data editor; consoles may still modify if the driver lacks read-only support) and Tx:Manual mode (changes wait for Submit and Commit / Roll Back) [DOC]. "Environment" appears in the data source dialog only as an environment/VM setting (e.g. Dev Container for WSL) [DOC].
6. **Cancelling and long runs.** Cancel Running Statements (toolbar or gutter progress indicator); Deactivate stops the IDE side while the query may keep running in the DB; a second cancel press shows a warning to terminate the remote process or keep waiting; an idle-cancel warning appears after 10 s; cancelling while connecting shows a "Connection canceled" message [DOC]. A notification can fire for queries running over 20 s (event group "Database queries that took much time") [DOC].
7. **Connection errors.** Docs give a manual checklist, not an error display: ping/telnet the host and port; verify host, database, user, password, port and privileges; match JDBC driver version; Windows temp-path ASCII requirement; SSH tunnel / SSL options (verification modes Require / Verify CA / Full); contact support [DOC]. Test Connection buttons exist on the data source dialog, SSH config and SSL settings [DOC]. How failures are rendered, and the JDBC-log feature, are not in the fetched page [not documented].
8. **Connection state.** Data sources with active sessions show a green dot; Deactivate (Ctrl+F2) closes the connection; Close Session / Close All Sessions end sessions; Switch Session reattaches a file/result [DOC]. Options: keep-alive query interval, auto-disconnect after N seconds, startup script, session control (shared / two sessions / dedicated per client) [DOC].
9. **Introspection progress.** Introspection loads metadata: scope = schemas selected via the "N of M" control; types Full / Incremental / Fragment; levels 1 (names) / 2 (no sources) / 3 (all) [DOC]. Progress display, background tasks and notifications are not described [DOC, absence]. Refresh is Ctrl+F5, Force Refresh Ctrl+Shift+F5, "Forget This Schema Cache" resets cached metadata and is suggested for sync errors [DOC]. Schema Refresh Time view option shows last introspection time per schema [DOC]. "Warn when editing outdated DDL" shows a notification when cached DDL differs from the DB [DOC]. Auto sync can refresh after DDL in a console; indirect changes may be missed [DOC]. Diagnostic mode shows "Diagnostic log started/stopped" popups [DOC].
10. **Notifications.** Documented ones: unsafe DELETE/UPDATE reminder, long-running query, outdated DDL, diagnostic log, conflict notification with Merge on submit, import-popup toggle via Hector icon [DOC]. A merge dialog (three-way diff) resolves submit conflicts [DOC].
11. **Execution scope dialogs.** Ctrl+Enter with several statements prompts to run all or one; selection behavior options: as single statement / separate statements / smart expand to script; running a transaction block as one statement makes statements succeed/fail together [DOC]. "Review parameters before execution" prompts for user parameters [DOC].
12. **AI permission consent (static evidence only).** [REA] Settings page "AI Tools" (Tools > Database) with Permissions toggles to allow, without confirmation: read schemas, read data (e.g. SELECT), modify data (INSERT/UPDATE/DELETE, routine calls), modify schemas (CREATE/ALTER/DROP). When not pre-allowed a per-statement consent dialog names the data source and schema with Allow / Deny and an "always allow" checkbox; reading data warns that data goes to the AI model; an "unknown" consent applies when safety analysis is unavailable for the dialect. Classes suggest QuerySafetyAnalyzer, DbOperationType, QueryResultTextMapper. Runtime behavior unobserved.

## Keyboard shortcuts

| Action                                 | Windows/Linux              | Source |
| -------------------------------------- | -------------------------- | ------ |
| Execute                                | Ctrl+Enter                 | [DOC]  |
| Cancel running statements / Deactivate | Ctrl+F2                    | [DOC]  |
| Next / previous error                  | F2 / Shift+F2              | [DOC]  |
| Error description at caret             | Ctrl+F1                    | [DOC]  |
| Query history                          | Ctrl+Alt+E                 | [DOC]  |
| Refresh / Force refresh                | Ctrl+F5 / Ctrl+Shift+F5    | [DOC]  |
| Fix with AI Assistant (syntax error)   | Alt+Enter, then menu entry | [DOC]  |
| Open settings                          | Ctrl+Alt+S                 | [DOC]  |

## Edge cases and error states

- Read-only is advisory when the driver lacks support; console DML may still run [DOC].
- Deactivate/cancel may leave the server-side statement running [DOC].
- The unsafe-query warning covers DELETE/UPDATE only per docs; DROP/TRUNCATE are not mentioned [DOC, absence]. A "suppress" path that disables the warning permanently is claimed in forum snippets only [not fetched].
- Auto-sync may miss indirect changes; manual refresh needed [DOC].
- Large SQL files: files over 20 MB show only the first 2.5 MB [DOC].
- Source for Tx:Auto: changes are committed and cannot be rolled back [DOC].
- Error message texts, codes, and line mapping for specific DBMSs are not documented [not documented].

## Implementation requirements for our app

- REQ-ERR-01 (MVP): Per-console Output log with timestamp, statement, duration, rows affected, tx mode, and error text; copyable, clearable, searchable.
- REQ-ERR-02 (MVP): On failure show the server message with position (line/column) when the driver reports one; highlight the offending range in the editor with a squiggle plus a hover tooltip; support next/previous error navigation.
- REQ-ERR-03 (MVP): Destructive-statement guard: parse statements and require explicit confirmation for DELETE/UPDATE without WHERE, plus DROP, TRUNCATE, and ALTER ... DROP; confirmation shows the statement and target connection; a global setting can disable it, per-run override only via the dialog.
- REQ-ERR-04 (MVP): Connection profile flags: "read-only" (enforced by our SQL classifier and, where supported, session read-only) and "environment" (e.g. production) that adds extra confirmation for any write statement and a visible colored badge. This extends beyond what the docs show.
- REQ-ERR-05 (MVP): Cancel control with two stages (request cancel, then offer kill/forcibly drop connection) and a clear "may still run on server" message.
- REQ-ERR-06 (MVP): Connection failure dialog with the driver message, a Test Connection action, and a short checklist (host/port reachability, credentials, TLS/SSH) rather than a raw stack trace.
- REQ-ERR-07 (MVP): Non-blocking progress indicator for schema introspection and large loads, with cancel; status bar item and toast on failure (Later: per-level introspection controls).
- REQ-ERR-08 (MVP): Notification center for long-running query completion (threshold configurable), stale-schema warnings, and transaction left open.
- REQ-ERR-09 (MVP): Uncommitted-transaction guard on close/disconnect.
- REQ-ERR-10 (MVP): AI-generated SQL passes through the same destructive-statement guard and is never auto-executed (see file 10).
- REQ-ERR-11 (Later): "Explain error" / "Fix error" actions that only send the error text and (with consent) schema context to the AI provider.
- REQ-ERR-12 (Later): Redact connection secrets and row data from any diagnostic bundle or log copy.

## Limitations / not verified

- No live UI capture was made; the fetch tool returns condensed summaries, so UI wording is approximate.
- Not in fetched docs: error message layout and position-to-highlight mapping, connection-failure presentation, introspection progress UI, any production/environment confirmation, whether DROP/TRUNCATE trigger warnings.
- `reporting-connection-issues.html` and the DBE-1456 issue were only seen as search snippets, not fetched.
- [REA] AI-permission evidence is static (jar inventory and strings); runtime dialog behavior was not observed.
