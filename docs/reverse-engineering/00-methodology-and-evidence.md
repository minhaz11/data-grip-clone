# 00 — Investigation Methodology and Evidence Inventory

Date: 2026-10-19 · Reference product: JetBrains DataGrip 2026.2.6 (build 262.10968.148), snap install at `/snap/datagrip/312`, Ubuntu 26.04 (GNOME, Wayland).

## Ground rules

- We study **observable behaviour and documented capabilities** only. We do not decompile, copy, or
  paraphrase JetBrains source code, and we do not copy icons, images, branding, or UI text verbatim
  beyond short attributed quotes.
- Every claim in `01`–`10` carries an evidence tag:
  - **[DOC]**: stated in official JetBrains documentation that was fetched (URL listed in that file).
  - **[CFG]**: observed in the user's own DataGrip configuration files (settings, layout); no secrets read.
  - **[REA]**: produced by an REA tool call, with an Evidence ID.
  - **[ASSUMPTION]**: our inference, not verified against the product.
- The user's database connections, console contents, and query data were **not** opened, executed, or
  copied. DataGrip was running with a live PostgreSQL JDBC helper process during the investigation, and
  we did not interact with it.

## What REA could and could not do on this host

`binary_session` reported (host = Linux):

| Capability                                                                           | Status                                           | Consequence                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| `observe_native_ui`, `capture_native_ui_scenario` (accessibility tree + screenshots) | **Unavailable**: macOS-only (`unsupported_host`) | No REA-driven live UI capture of DataGrip.                                    |
| `inspect_artifact` / `open_binary` on ZIP/JAR                                        | Available                                        | Used for static inventory of a shipped module (below).                        |
| Browser/web capture tools                                                            | Available                                        | Not needed; the docs were fetched as text by research agents.                 |
| `capture_process_scenario`                                                           | Available                                        | Not used: launching a second DataGrip instance gives no UI evidence on Linux. |
| `inspect_sqlite_database`                                                            | Requires Node ≥ 24.15; host has Node 22.23       | Not used.                                                                     |
| ADB, Frida, Mach-O tools                                                             | Not applicable / unavailable                     | n/a                                                                           |

Manual screen capture was also not possible:

- DataGrip runs with `-Dawt.toolkit.name=auto` and no X11 window was found (`xwininfo -root -tree`),
  so it is using JetBrains Runtime's **native Wayland toolkit**.
- On GNOME Wayland, screenshots need an interactive xdg-desktop-portal consent, and no X11 grab tools
  (`xwd`, `import`) are installed. We did not try to get around this.

**Result:** there is **no live UI capture** in this investigation. UI-state descriptions come from
official docs ([DOC]) and the user's layout configuration ([CFG]).

**To close this gap:** the user can attach their own screenshots (taken with GNOME's screenshot tool),
or a later run on macOS can use REA's native UI tools.

## Evidence inventory

### E1 — Product identity [CFG]

`/snap/datagrip/312/product-info.json`: name DataGrip, version 2026.2.6, build 262.10968.148,
data dir `DataGrip2026.2`, minimum Java 25, Linux launcher `bin/datagrip`, WM class `jetbrains-datagrip`.

### E2 — Feature/module inventory (directory listing of shipped plugin jars) [CFG]

`plugins/DatabaseTools/lib/modules/` contains, among others:

- **Dialects**: one module (often plus an `.ex` extension) per engine: `sql92`, `generic`, `postgres`,
  `postgresbase`, `greenplum`, `redshift`, `cockroach`, `mysql`, `mysqlbase`, `maria`, `sqlite`, `mssql`,
  `sybase`, `oracle`, `db2`, `h2`, `hsql`, `derby`, `clickhouse`, `snowflake`, `bigquery`, `vertica`,
  `exasol`, `hive`, `spark`, `cassandra`, `mongo`, `redis`, `couchbase`, `dynamo`.
  → **[ASSUMPTION]** SQL support is layered as a generic/SQL-92 base with dialect families
  (e.g. `postgresbase` shared by Postgres/Greenplum/Redshift) on top. We will use the same idea:
  a base dialect plus per-engine overrides.
- **Cross-cutting modules**: `connectivity`, `ssh`/`ssh.ui`, `jdbcConsole`, `ai`, `mcp`,
  `impl.bookmarks`, `impl.navbar`, `cliCommands`, `completionMlRanking`, `sql.*` (language core/frontend/backend).
- **Grid**: `grid-core-plugin` (`grid`, `grid.impl`, `grid.types`, `grid.csv.core`) and `grid-plugin`
  (`charts`, `images`, `json`, `scripting`), plus `grid-loader-json` and `grid-loader-xls`.
  → The result grid is a standalone component that is independent of the SQL engine. We mirror this
  separation.
- Query execution happens out of process: a separate JVM runs `com.intellij.database.remote.RemoteJdbcServer
org.postgresql.Driver` (seen in the process list). → **[ASSUMPTION]** Drivers are isolated from the UI
  process. Our Rust backend gives the same isolation from the WebView.

### E3 — User configuration [CFG]

- `options/window.layouts.xml`: tool window **Database** is anchored LEFT (weight 0.25). **Project** and
  **Structure** are anchored RIGHT (Structure split). **Version Control, Find, Run, Debug, Inspection** are
  anchored BOTTOM.
- `options/databaseDrivers.xml`: PostgreSQL JDBC 42.7.13 and MySQL Connector/J 9.7.0 are downloaded on demand.
- `options/csvSettings.xml` / `databaseSettings.xml`: four built-in delimited formats (CSV `,`, TSV tab,
  pipe `|`, semicolon `;`), each with `nullText=""`, quoting "as needed", and `"`/`'` quote pairs
  escaped by doubling. Query **parameter patterns** are regexes scoped by language (e.g. `${name}`,
  `$(name)`, `:'name'` for PostgreSQL, `%(name)s` for Python).
- `consoles/db/<data-source-uuid>/console.sql, console_1.sql, …`: query consoles are plain `.sql` files,
  one folder per data source. Only file names were observed, not contents.
- `options/editor.xml`: `REFORMAT_ON_PASTE=1` (a user preference).

### E4 — AI module static inventory [REA]

- Tool: `open_binary` + `inspect_artifact` on `plugins/DatabaseTools/lib/modules/intellij.database.ai.jar`
  (SHA-256 `c8f6e898f22da8bf3ce440d4b960ac05cd4f3b348024a991fccf8afe4ce95f87`).
- Evidence: inspection `ev_4cd56ab7b91adff047471f281faef3c0a0b40fc2a7fb8fbe84d6d3fcb9627ae7`, summary view
  `ev_00a632faf630556dcde67be90ae2e750b4b7a721b12401a17a828a64f5ce8a2a`. Coverage: complete,
  91/91 central-directory entries. Bundle: [`evidence/rea-datagrip-ai-module.bundle.json`](evidence/rea-datagrip-ai-module.bundle.json).
- We read the class **names** and the user-facing string bundle (UI text the user would see anyway).
  No bytecode was decompiled.
- Findings (static; runtime not observed):
  - There is a settings page, AI Tools → Permissions, with four independent grants: **read schema**,
    **read data**, **modify data**, **modify schema**.
  - When a grant is not pre-approved, a per-statement **consent dialog** names the data source and
    schema, offers Allow/Deny, and has an "always allow" option. Reading data warns that results will be
    sent to the model.
  - There is a fallback "unknown" consent for dialects where statement safety analysis is unavailable.
  - Class names (`QuerySafetyAnalyzer`, `DbOperationType`, `QueryResultTextMapper`, `ConsentContext`)
    suggest statements are classified before an AI-initiated execution, and that results are converted
    to text for the model.
- Implication for us: AI access needs **explicit, scoped, revocable consent per operation class**.
  Unclassifiable SQL must be treated as the most dangerous class.

## Workflow coverage matrix

| #   | Workflow                        | File                                  | Evidence types | Live UI observed? |
| --- | ------------------------------- | ------------------------------------- | -------------- | ----------------- |
| 1   | Layout, navigation, shortcuts   | `01-layout-navigation-shortcuts.md`   | DOC, CFG       | No                |
| 2   | Connections                     | `02-connections.md`                   | DOC, CFG       | No                |
| 3   | Database explorer               | `03-database-explorer.md`             | DOC, CFG       | No                |
| 4   | SQL editor and execution        | `04-sql-editor.md`                    | DOC, CFG       | No                |
| 5   | Result grid and editing         | `05-result-grid.md`                   | DOC, CFG       | No                |
| 6   | Schema/table tools              | `06-schema-table-tools.md`            | DOC            | No                |
| 7   | Import/export                   | `07-import-export.md`                 | DOC, CFG       | No                |
| 8   | History, consoles, environments | `08-history-consoles-environments.md` | DOC, CFG       | No                |
| 9   | Errors, dialogs, confirmations  | `09-errors-dialogs-confirmations.md`  | DOC            | No                |
| 10  | AI assistance                   | `10-ai-assistant.md`                  | DOC, REA       | No                |

See each file's "Limitations" section for what it does not cover.

## Cross-file caveats (from the review on 2026-10-19)

- **[DOC] fidelity.** The docs were fetched with a tool that returns a model-written _summary_ of each
  page, not the raw HTML. Labels and menu paths are therefore relayed and may be slightly off. Verify
  exact wording against the live docs before relying on it. This does not affect our design, because
  we do not copy wording.
- **About 35 doc URLs returned 404 or an empty body.** Each file lists its own failures. The fallback
  pages used instead are listed in that file's Sources section.
- **Snippet-only claims** (search-result text, not fetched pages) are labelled as such and are not
  tagged [DOC]. These include:
  - the AI "Generate Code" shortcut;
  - the 2024.1 schema-attachment cap;
  - the folder-delete confirmation;
  - the EAP "Transparent" transaction mode.
- **Conflicts we know about:**
  - `01`: Ctrl+Shift+F10 is listed both as "Run file" and "Jump to query console". The binding is
    context-dependent, and the docs list both.
  - `05`: different pages give different delete-row shortcuts.
  - `10`: the AI data-handling page says DataGrip's AI does not access database data. The
    database-skills page and the [REA] permission model (E4) show that agents can read data when
    allowed. **We design for the stricter reading**: data can leave the machine only with explicit
    consent (ADR-0005).
  - `07`: the user's config [CFG] has four delimited formats; the docs name three predefined formats.
- **No "production environment" concept exists in the docs.** DataGrip offers colours and a read-only
  flag. Our environment tag (dev/staging/prod) and production-write confirmation are **our own design**
  (overview → Safety model), not observed behaviour.
- **Keyboard shortcuts.** Our default keymap may use the same common key combinations for
  familiarity, but it is our own fully rebindable keymap. Bindings the docs gave only as macOS keys
  are marked unstated and are not guessed.
