# 02 — Connections (Data Sources)

## Sources

All fetched 2026-10-19 from official JetBrains DataGrip help (relayed through the fetch tool's summarising step).

- https://www.jetbrains.com/help/datagrip/connecting-to-a-database.html
- https://www.jetbrains.com/help/datagrip/managing-data-sources.html
- https://www.jetbrains.com/help/datagrip/data-sources-and-drivers-dialog.html
- https://www.jetbrains.com/help/datagrip/configuring-database-connections.html
- https://www.jetbrains.com/help/datagrip/postgresql.html
- https://www.jetbrains.com/help/datagrip/mysql.html
- https://www.jetbrains.com/help/datagrip/connectivity-problems.html
- https://www.jetbrains.com/help/datagrip/cannot-connect-to-a-database-because-of-sslhandshakeexception.html
- https://www.jetbrains.com/help/datagrip/configuring-ssh-and-ssl.html
- https://www.jetbrains.com/help/datagrip/connect-to-a-database-with-ssh.html
- https://www.jetbrains.com/help/datagrip/introspection.html
- https://www.jetbrains.com/help/datagrip/reference-ide-settings-password-safe.html
- https://www.jetbrains.com/help/datagrip/sessions.html
- https://www.jetbrains.com/help/datagrip/database-tool-window.html

Fetch attempts that returned HTTP 404 (not used): cannot-connect-to-a-database.html, connect-to-a-database-using-an-ssh-tunnel.html, connecting-to-a-database-using-ssl.html, user-defined-database-drivers.html, connection-troubleshooting.html, database-color-settings-dialog.html (also 404 when retried).

## Evidence legend

- [DOC] stated in fetched official docs.
- [CFG] observed in the user's local DataGrip 2026.2.6 config on Linux.
- [ASSUMPTION] our inference, not verified.

## Observed workflows

1. **Create a data source.** Open the Data Sources and Drivers dialog (Ctrl+Alt+Shift+S, File | Data Sources, or the Data Source Properties button), or use New (Alt+Insert) | Data Source | vendor in Database Explorer [DOC]. Choose a driver (default is kept unless another is needed), a connection type, fill fields, Test Connection, optionally pick schemas, OK [DOC]. The data source then appears in Database Explorer; F4 opens a console, double-click an object opens the data editor [DOC].
2. **General tab fields.** Connection type: "URL only" shows User, Password, URL; DBMS-specific types build the URL from fields and the URL stays editable [DOC]. Fields: Driver, File/Path (file-based DBs, open/save icons), Host (IPv4/IPv6; with SSH it must be reachable from the SSH host), Port, Database, User, Password, Save (password storage), URL, Create database (only for some DBMSs, e.g. embedded Derby), Test Connection with a copy button exporting communication info [DOC]. A name field and a color circle sit at the top of the dialog [DOC].
3. **PostgreSQL specifics.** Connection types: default (Host, Port 5432, Database, URL) or URL only. Auth types: pgpass, User & Password, No auth (URL only: User & Password, No auth). URL form jdbc:postgresql://host:port/database. Supported server versions stated as 9.1 to 18. Kerberos documented as a separate manual setup (JAAS config, VM option, `gsslib=sspi` on Windows) [DOC].
4. **MySQL specifics.** Connection types: default, Unix socket, URL only. Auth types: User & Password, No auth. Default port 3306; URL uses an `address=(protocol=tcp)(host=..)(port=..)` form; socket form needs a junixsocket factory class in the URL. Supported versions stated as 5.1 to 9.x [DOC].
5. **Driver handling.** If drivers are missing, a "Download missing driver files" link appears; downloads go to the DataGrip config directory [DOC]. Local config shows PostgreSQL JDBC 42.7.13 and MySQL Connector/J 9.7.0 in databaseDrivers.xml [CFG]. Drivers tab: Class, Driver Files (download latest, pick version, add local JARs), URL templates with `{host}`, `{port}`, `{database}` and optional `[...]` parts; driver-level Options (transaction control, switch schema, startup script, keep-alive query, auto sync, load sources, send application info, dialect, code style) and Advanced (VM options/env), plus expert options (disable incremental introspection, introspect via JDBC metadata, isolate class path, use IDE proxy) [DOC]. Custom JAR path: Drivers tab → Add → Driver Files → Add → Custom JARs, set Class [DOC].
6. **Password storage.** Save list: Never (prompt every connection), Until restart (kept for current run), For session (until disconnect/Deactivate), Forever (kept in storage), plus a link to IDE password settings [DOC]. DataGrip has no own store; it uses the OS keychain or KeePass (c.kdbx, optional master password and PGP); native keychain not available on Windows; on Linux depends on desktop environment (GNOME Keyring preferred if both it and KWallet exist); "do not save" mode prompts always [DOC]. Setting path: Appearance & Behavior | System Settings | Passwords [DOC]. Exported/shared XML excludes passwords except URL-only connections where they sit in the URL [DOC].
7. **Options tab.** Read-only (blocks edits in the data editor; consoles may still allow edits if the driver ignores read-only), Transaction control Auto/Manual with DBMS-dependent isolation levels, Switch schema (Automatic / Manual / Disable), Time zone, "Run keep-alive query each N", "Auto-disconnect after N seconds", Single database mode (PostgreSQL, Azure SQL, Greenplum, Redshift), Session control (Single shared / Two sessions: shared and introspection / Dedicated), Startup script with macros, Before connection tasks, Session Templates [DOC].
8. **SSH/SSL tab.** SSH: "Use SSH tunnel", pick or add an SSH configuration (Host, Port, Username; auth Password / Key pair (OpenSSH or PuTTY) / OpenSSH config and authentication agent), Test Connection in the SSH dialog, optional Local port (empty = dynamic) [DOC]. With ssh-agent and Pageant both running, only ssh-agent is used [DOC]. SSH configurations are shared across a project's data sources unless "Visible only for this project" is set [DOC]. General-tab host normally stays as the DB's address as seen from the SSH host [DOC]. SSL: "Use SSL", CA file, truststore (IDE / JAVA / System), client certificate and key file, mode Require / Verify CA / Full Verification, "Copy from…" other data source; PEM recommended [DOC].
9. **Schemas tab and introspection scope.** Toolbar Refresh/Expand/Collapse with a filter field; Schema pattern syntax (`@` current, `*` all, e.g. `*:*`, `@:*`, `@:@`, `db:s1,s2`); Object filter `<type>:[-]<regex>` affecting visibility only; PostgreSQL toggles for internal system schemas and template databases [DOC]. Only schemas selected for display are introspected; objects in non-introspected schemas do not resolve in consoles [DOC]. Levels 1 (names), 2 (all but source), 3 (everything) for Redshift, MariaDB, SQL Server, MySQL, Oracle, PostgreSQL; types Full, Incremental, Fragment [DOC]. Options tab Introspection group: Auto sync, Load sources for (all / excluding system / none), default level, Warn when editing outdated DDL, Track databases/schemas creation and deletion, automatic introspection interval, virtual objects file [DOC]. Refresh Ctrl+F5, Force Refresh Ctrl+Shift+F5, "Forget This Schema Cache" [DOC].
10. **Test Connection.** Link/button at the bottom of General; also in the SSH configuration dialog and Cloud pane [DOC]. Docs for PostgreSQL/MySQL state a failure leads to the "Cannot connect to a database" topic; the pages do not describe the success or failure UI text [DOC]. Test Connection on an SSL handshake failure can surface a notification offering to edit disabled algorithms or enable TLSv1 / TLSv1.1 / all protocols (MySQL) [DOC].
11. **Advanced tab.** Key/value driver properties table (type in last row to add), VM options, VM environment (e.g. NLS_LANG for Oracle), working directory [DOC].
12. **Duplicate.** Copy/Paste | Duplicate, dialog Duplicate button or Ctrl+D; keeps all settings including the password; duplicate stays within one project [DOC].
13. **Edit.** No dedicated section; edit in the dialog and press OK; Reset Changes (Ctrl+Alt+Z) reverts unsaved edits; Change Driver in the context menu; Go to Driver Ctrl+B [DOC].
14. **Remove.** Explorer context "Remove Data Source" or dialog Remove / Delete key [DOC].
15. **Scope and sharing.** Data sources are project-level by default and stored in dataSources.xml under .idea; "Make Global" shares across projects, "Move to Project" reverses [DOC]. Share by copying a data source as an XML snippet (Ctrl+C), pasting with Ctrl+V or New | Import from Clipboard, or by exporting global sources via IDE settings export [DOC]. A dataSourcesHistory/<id>/data_sources_history.xml file exists locally; its role is not documented in fetched pages [CFG].
16. **Sessions.** A session wraps one connection and holds state such as active flag and transaction mode; DataGrip does not connect at startup and uses cached metadata; sessions are created lazily by consoles, data editors, attached files, routines and run configurations; a green dot means connected; Deactivate (Ctrl+F2) closes the connection [DOC]. Per-dialect modules and an ssh module ship with the IDE [CFG].
17. **Other data source kinds.** DDL data sources (SQL files with DDL, with Extend parent and ordered sources), data source templates (stored in the user's JetBrains account), cloud data sources with a Databases pane [DOC].

## Keyboard shortcuts

| Action                         | Windows/Linux           | Source |
| ------------------------------ | ----------------------- | ------ |
| Open Data Sources and Drivers  | Ctrl+Alt+Shift+S        | [DOC]  |
| Add data source/driver         | Alt+Insert              | [DOC]  |
| Remove selected                | Delete                  | [DOC]  |
| Duplicate                      | Ctrl+D                  | [DOC]  |
| Go to Driver                   | Ctrl+B                  | [DOC]  |
| Reset Changes                  | Ctrl+Alt+Z              | [DOC]  |
| Show Driver Usages             | Alt+F7                  | [DOC]  |
| Add SSH configuration (browse) | Shift+Enter             | [DOC]  |
| Deactivate connection          | Ctrl+F2                 | [DOC]  |
| Refresh / Force Refresh        | Ctrl+F5 / Ctrl+Shift+F5 | [DOC]  |
| Open default console           | F4                      | [DOC]  |
| Copy / Paste data source       | Ctrl+C / Ctrl+V         | [DOC]  |

## Edge cases and error states

- URL-only type stores the JDBC URL, including credentials if typed there, in plain text and in the IDE log and data source file [DOC].
- Read-only may not stop writes from consoles if the driver lacks read-only support [DOC].
- Exported data source XML omits passwords [DOC]; imported sources need credentials re-entered and a Test Connection [DOC].
- Connection checklist from docs: ping/telnet to host and port, verify host/database/user/password/port, driver and server compatibility, Windows non-ASCII temp path (fix via VM option for java.io.tmpdir), SSL/SSH requirements [DOC].
- Documented default ports include PostgreSQL 5432, MySQL/MariaDB 3306, SQL Server 1433, Oracle 1521, ClickHouse 8123, Snowflake 443, Redshift 5439; SQLite none [DOC].
- SSL: connection fails if either certificate cannot be verified; self-signed certs may fail with the newest driver [DOC]. Java disabling TLS 1.0/1.1 causes `javax.net.ssl.SSLHandshakeException` against old servers [DOC].
- Manual (external) SSH tunnels via PuTTY, Pageant or ssh-agent are an alternative to the built-in tunnel; the host field then points at the server's address on the isolated network [DOC].
- WSL databases: set the Environment field to Dev Container [DOC].
- Changing Session control may disconnect sessions after an Apply Changes confirmation [DOC].
- Sessions reappear empty in the Services window after IDE restart [DOC].
- Duplicate cannot cross projects; global/project scope conversion is explicit [DOC].
- Cancelling connection creation shows a "Connection canceled" message [DOC, run-a-query page].
- Introspection can be slow and disk-heavy on large databases; mitigations: fewer schemas, incremental/fragment mode, lower level [DOC].

## Implementation requirements for our app

- REQ-CONN-01 (MVP): Connection profile model: id (uuid), name, driver/dialect, host, port, database, user, auth type, URL override, options, tags/color, folder. Persisted as JSON/TOML; secrets never in the file.
- REQ-CONN-02 (MVP): Connection form with typed fields and a derived, editable URL/DSN preview; "URL only" mode with a plaintext-secret warning.
- REQ-CONN-03 (MVP): Test Connection action with distinct outcomes: success (server version, latency), network failure (DNS/refused/timeout), auth failure, TLS failure, driver/protocol failure; copyable diagnostic text.
- REQ-CONN-04 (MVP): Duplicate, remove (with confirm), rename, reorder, folder grouping; unsaved-changes revert.
- REQ-CONN-05 (MVP): Password policy per connection: Never / Until app restart / Forever (OS keychain via Tauri keyring plugin); optional "for this session" mapped to disconnect. Our own storage design; no plaintext fallback.
- REQ-CONN-06 (MVP): Options: read-only flag enforced client-side (statement classification) and, where the DBMS supports it, by session setting; default transaction mode; keep-alive interval; auto-disconnect; connect timeout; startup SQL.
- REQ-CONN-07 (MVP): SSH tunnel: host, port, user, auth (password, key file + passphrase, agent), optional local port, reusable named SSH profiles shared across connections.
- REQ-CONN-08 (MVP): TLS options: mode (require / verify CA / verify full), CA, client cert, client key; PEM supported.
- REQ-CONN-09 (MVP): Schema/database selection tab (checkbox tree plus pattern filter) controlling introspection scope; object-visibility filter separate from scope.
- REQ-CONN-10 (Later): Introspection levels (names / structure / full source), incremental refresh, auto-sync after DDL, introspection interval.
- REQ-CONN-11 (Later): Driver abstraction for DBMS-specific connection types (socket, file path, pgpass) and per-dialect default ports.
- REQ-CONN-12 (Later): Export/import connection definitions without secrets; global vs workspace scope; templates.
- REQ-CONN-13 (MVP): Session model: lazy connect on first need, visible active/inactive state, Deactivate action, selectable session control (shared vs dedicated sessions).

## Limitations / not verified

- No live UI capture was made; all UI text, controls and defaults come from fetched help text relayed through a summarising fetch tool.
- Authentication-type lists beyond PostgreSQL (pgpass, User & Password, No auth), MySQL (User & Password, No auth) and SSH types were not documented in fetched pages; AWS IAM, Windows auth, Kerberos for other DBs, etc. are unverified.
- The dedicated "Cannot connect to a database" page (connectivity-problems.html) lists no concrete error message strings beyond SSLHandshakeException; exact Test Connection success/failure UI text is not in the docs fetched.
- Connect/query timeout settings other than keep-alive and auto-disconnect were not found; isolation-level lists per DBMS not documented.
- JDBC log settings (Diagnostics | Show JDBC Log Settings) appear in the Explorer context-menu docs but troubleshooting steps for them were not fetched.
- Default values (e.g. which "Save" option is preselected, default Switch schema mode) were not stated in fetched pages.
- Local CFG facts are file/driver names only; no connection XML contents were inspected.
