# 03 — Database Explorer

## Sources

All fetched 2026-10-19 from the official DataGrip help (documentation labelled 2026.2). Content was obtained through a fetch tool that returns a model-written summary of each page, not the raw HTML, so wording is paraphrased and fine details may be lost.

- https://www.jetbrains.com/help/datagrip/database-tool-window.html
- https://www.jetbrains.com/help/datagrip/database-explorer.html
- https://www.jetbrains.com/help/datagrip/introspection.html
- https://www.jetbrains.com/help/datagrip/introspection-levels.html
- https://www.jetbrains.com/help/datagrip/schemas.html
- https://www.jetbrains.com/help/datagrip/databases.html
- https://www.jetbrains.com/help/datagrip/show-all-databases-or-schemas.html
- https://www.jetbrains.com/help/datagrip/data-sources-and-drivers-dialog.html
- https://www.jetbrains.com/help/datagrip/glossary.html
- https://www.jetbrains.com/help/datagrip/settings-tools-database-explorer.html
- https://www.jetbrains.com/help/datagrip/speed-search-in-the-tool-windows.html
- https://www.jetbrains.com/help/datagrip/full-text-search-for-databases.html
- https://www.jetbrains.com/help/datagrip/viewing-reference-information.html
- https://www.jetbrains.com/help/datagrip/export-data.html (DDL / SQL Generator sections only)
- https://www.jetbrains.com/help/datagrip/code-editor-navigation.html
- https://www.jetbrains.com/help/datagrip/modifying-source-code-of-database-objects.html
- https://www.jetbrains.com/help/datagrip/rows.html (Go To | Related Rows only)
- https://www.jetbrains.com/help/datagrip/foreign-keys.html
- https://www.jetbrains.com/help/datagrip/virtual-foreign-keys.html
- https://www.jetbrains.com/help/datagrip/creating-diagrams.html
- https://www.jetbrains.com/help/datagrip/schema-comparison-and-migration.html
- https://www.jetbrains.com/help/datagrip/managing-connection-sessions.html

Fetch failures: `database-objects.html` returned an empty body; `database-diagrams.html` returned HTTP 404 (the working diagram page is `creating-diagrams.html`). The `#sync` ("Synchronize") section of database-explorer.html was not included in the returned text.

## Evidence legend

- [DOC] stated in fetched official docs.
- [CFG]/[REA] local observation. None were supplied for this topic.
- [ASSUMPTION] our inference, not verified.

## Observed workflows

1. **Browse the tree.** Expand a data source to see databases and schemas, then object groups, then objects, then (optionally) element groups under a table.
   - Top level is data sources (and DDL data sources), which can sit in folders and subfolders. [DOC]
   - Under a data source only databases/schemas ticked in the "N of M" schema selector are shown. [DOC]
   - Under a schema: groups for Schema Objects (tables, views, routines) and for Server and Database Objects (users, roles, tablespaces and other rare objects); with the Object Elements option on, a table shows groups for columns, indexes, keys, triggers. [DOC]
   - Documented node kinds include data source, database, schema, folder, role, user, tablespace, extension; table, view, materialized view, foreign table, sequence, synonym; column, primary key, foreign key, key, index, check, default, trigger, rule; procedure/function, package, operator, aggregate; and alias/object/collection types. [DOC]
   - Column icons combine markers for foreign key, primary key, index and NOT NULL. [DOC]
   - Virtual objects (virtual table, view, column, foreign key) have their own node kinds. [DOC]

2. **Choose which schemas are introspected.** Click "N of M" next to the data source, tick databases/schemas, press Enter. [DOC]
   - Alternative paths: Tools | Manage Shown Schemas on a data source, or the Schemas tab in Data Sources and Drivers. [DOC]
   - The selector has an All schemas node and an add-pattern button; a filter node takes a Java regex and can be nested under any node; multiple patterns are unioned. [DOC]
   - A new data source starts with no databases/schemas selected. [DOC]
   - Default schema can be set per console (toolbar dropdown) or per data source (Database field, General tab). [DOC]

3. **Show everything without introspecting.** View Options | Show Elements | All Namespaces lists every schema/database; names of non-introspected ones are grey. Select one and Refresh to introspect it. [DOC]

4. **Introspection levels (lazy detail).** Right-click a database or schema, choose Introspection Level, pick 1, 2 or 3. [DOC]
   - Level 1: names and signatures only; column types load as unknown; no index column names. Level 2: everything except source code (routine bodies). Level 3: everything. [DOC]
   - Children inherit the parent's level; the explicit level is shown in blue, inherited in grey when "Introspection Level Icons" is enabled in View Options (off by default). [DOC]
   - Defaults per schema depend on object count N: current schema L3 if N<=1000, L2 if N<=3000, else L1; non-current L2 if N<=3000 else L1; system schema L2 if N<=100 else L1. [DOC]
   - Default level is changed in Data Sources and Drivers, Options | Introspection | Default level. [DOC]
   - Levels exist only for Oracle, MySQL, MariaDB, SQL Server, PostgreSQL, Redshift; other databases are fully introspected. [DOC]
   - Fragment introspection fetches one object on demand (example given: opening a view at a low level fetches its source then). [DOC]
   - The docs never use the phrase "lazy loading". Closest behaviour: on-demand per-object fetch plus level inheritance. [DOC]

5. **Refresh / synchronise.**
   - Refresh (Ctrl+F5) re-syncs the selected element with the database. [DOC]
   - Force Refresh (Ctrl+Shift+F5, data source nodes) drops cached data-source info and reloads from scratch. [DOC]
   - Forget This Schema Cache (data source nodes) discards accumulated metadata; advised when the tree is wrong or sync errors appear. [DOC]
   - Auto sync (data source Options tab): refreshes after OK in the properties dialog and after DDL run in that data source's consoles; when off, only manual Refresh updates. Since 2024.2, for Oracle and SQL Server only objects a DDL statement can affect are refreshed, so indirect changes may be missed. [DOC]
   - Other Options-tab introspection settings: Load sources for (all / except system / none); track creation and deletion of databases/schemas; automatic introspection interval in minutes; warn when editing outdated DDL; use pre-introspected system catalogs. [DOC]
   - Introspection types: full (all selected schemas), incremental (changed objects only), fragment (selected objects on Refresh; smart refresh after console statements). [DOC]
   - Diagnostics: Diagnostic Mode, Dump Metadata Model, Generate Introspector Diagnostic Files. [DOC]

6. **Filter and search the tree.**
   - Speed search: start typing in the tree; matches highlight; Up/Down moves between matches; Enter opens; Escape hides the field. Works only on expanded nodes. [DOC]
   - Speed Search Filter (Filter button) hides non-matching nodes; a setting "Remember whether the filter is ON" keeps it between searches. [DOC]
   - Item filter (View Options | Filter) hides object types; a green dot on the icon signals active filtering. [DOC]
   - Object filter patterns (Schemas tab), example `table:-payment_.*` — affects visibility, not the introspection scope. [DOC]
   - Grouping toggles in View Options: Databases and Schemas, Server and Database Objects, Object Elements, Schema Objects, Schema Objects by Prefix (delimiters `_`, `-`, `$`), Separate Procedures and Functions (SQL Server, Oracle, PostgreSQL), Sort Alphabetically. [DOC]
   - Show Elements toggles: All Namespaces, Empty Groups, Intermediate Nodes, Generated Objects (Oracle), Virtual Objects, Query Files; Node Details: comments instead of details, schema refresh time. [DOC]
   - Full-text search across data (not names): Tools | Full-Text Search on selected databases/schemas/tables; options Match case, Contains/Starts with/Ends with/Matches/LIKE pattern, column-type scopes, first N matches per table; results go to the Find tool window. [DOC]

7. **Open an object.** Double-click a table to open the data editor; F4 does Edit Data for table/view/materialized view and shows a group's contents as a table for group nodes. [DOC] Ctrl+B / DDL button / Navigation | Go to DDL opens the object's DDL in the editor. [DOC]

8. **Quick Documentation.** Ctrl+Q on a table in tree or editor shows data source, database, schema, name, generated definition, and a "Show table preview" link; PostgreSQL and MySQL also show table size. [DOC]
   - Generic mechanism: Ctrl+Q popup, press again to dock into the Documentation tool window; hover popup is optional. [DOC]

9. **Navigate relations (FK).** In the data editor, Go To | Related Rows from the cell context menu or the quick-actions popup; several values can be selected at once. [DOC]
   - Relations come from explicit foreign keys or virtual foreign keys (IDE-only, stored in `external-data-<datasource>.xml`, created via New | Virtual Foreign Key, "Store table relation" intention, or regex rules in Database | Other). [DOC]
   - Explicit FKs feed JOIN generation, completion, data navigation, diagrams. [DOC]
   - When FKs point at same-named objects in different schemas the navigation dialog shows qualified names. [DOC]

10. **Generate DDL / SQL.**

- SQL Generator: right-click, SQL Scripts | SQL Generator (Ctrl+Alt+G); toolbar Copy, Save to File, Run in a console; file output layouts (per object by schema; by schema and database; per object; per object with order; by schema and type). [DOC]
- Generate DDL to Clipboard (Ctrl+Alt+Shift+G) and to Query Console (Ctrl+Alt+Shift+B); Request and Copy Original DDL asks the server for stored source. [DOC]
- Go to DDL (Ctrl+B) output has unqualified references and is editable; for a runnable script with CREATE OR REPLACE and qualified names use the SQL Generator. [DOC]
- Edited DDL is submitted (Ctrl+K), producing an Object Migration dialog with the generated script; objects show black (in sync), blue (locally modified) or red (conflict). [DOC]
- Compare Structure With (Ctrl+D) on two same-kind objects opens a Migration dialog with Origin/Target, script preview, Execute or Open Query in Console. [DOC]

11. **Diagrams.** Right-click data source/schema/table, Diagrams | Show Diagram (Ctrl+Alt+Shift+U tab, Ctrl+Alt+U popup). Nodes are tables, edges are PK/FK relations; toolbar toggles key columns, other columns, virtual FKs, comments; layouts, zoom, find (Ctrl+F), focus on paths/neighbourhood; export to image/Mermaid/PlantUML/DOT/etc. [DOC]

12. **Organise data sources.** Folders (`.idea/db-forest-config.xml`), Move | To Folder (F6), reorder Alt+Shift+Up/Down, colours per node. [DOC]

## Keyboard shortcuts

| Action                              | Windows/Linux                       | Source |
| ----------------------------------- | ----------------------------------- | ------ |
| New (data source, console, ...)     | Alt+Insert                          | [DOC]  |
| Data Sources and Drivers            | Ctrl+Alt+Shift+S                    | [DOC]  |
| Refresh                             | Ctrl+F5                             | [DOC]  |
| Force Refresh                       | Ctrl+Shift+F5                       | [DOC]  |
| Deactivate (close connection)       | Ctrl+F2                             | [DOC]  |
| Jump to Query Console               | Ctrl+Shift+F10                      | [DOC]  |
| Quick Documentation                 | Ctrl+Q                              | [DOC]  |
| Go to DDL                           | Ctrl+B                              | [DOC]  |
| Edit Data / group as table          | F4                                  | [DOC]  |
| Compare Structure                   | Ctrl+D                              | [DOC]  |
| Rename                              | Shift+F6                            | [DOC]  |
| Copy Table to                       | F5                                  | [DOC]  |
| To Folder                           | F6                                  | [DOC]  |
| Expand / Collapse all               | Ctrl+NumPad + / -                   | [DOC]  |
| SQL Generator                       | Ctrl+Alt+G                          | [DOC]  |
| Generate DDL to clipboard / console | Ctrl+Alt+Shift+G / Ctrl+Alt+Shift+B | [DOC]  |
| Diagram (tab / popup)               | Ctrl+Alt+Shift+U / Ctrl+Alt+U       | [DOC]  |
| Full-text search                    | Ctrl+Alt+Shift+F                    | [DOC]  |
| Hide tool window                    | Shift+Escape                        | [DOC]  |

## Edge cases and error states

- Tree shows wrong structure or sync errors: Forget This Schema Cache, then Synchronize. [DOC]
- Objects in schemas that were not introspected do not resolve in consoles. [DOC]
- Level 1/2 hide routine bodies and unknown column types until the level is raised or the object is refreshed. [DOC]
- Cached DDL differs from server: notification "cached object differs" with Synchronize or Disable check; on submit conflict, Force Refactoring / Abort and Synchronize, then Revert / Keep local / Merge. [DOC]
- Auto sync can miss indirect effects of DDL (Oracle, SQL Server since 2024.2). [DOC]
- Introspection of large databases is slow and disk-heavy; levels are unavailable for e.g. Azure SQL Database and Greenplum supports only incremental. [DOC]
- Related Rows needs explicit or virtual FKs; there is no documented fallback by column name for navigation. [DOC for the requirement; absence of fallback is our reading]
- Ctrl+F2 and Ctrl+D are each documented for two different actions depending on context. [DOC]
- Non-introspected schemas are shown grey and contain nothing beyond the name. [DOC]

## Implementation requirements for our app

Design target: React tree in a Tauri shell; Rust backend with PostgreSQL first (queries against `information_schema` / `pg_catalog` are our choice, not from the docs).

- REQ-EXPL-01 (MVP) Tree levels: connection > database > schema > groups (Tables, Views, Materialized Views, Routines, Sequences) > object > element groups (Columns, Keys, Indexes, Triggers). Groups hideable.
- REQ-EXPL-02 (MVP) Per-connection schema selector ("N of M" analogue) with checkboxes; only selected schemas are loaded; new connections start with the default schema selected (a deliberate difference, [ASSUMPTION] for usability).
- REQ-EXPL-03 (MVP) Lazy loading: load schema list on connect, object names on schema expand, columns/indexes on table expand; show spinner and cancel on slow loads.
- REQ-EXPL-04 (MVP) Manual Refresh per node and Force Refresh per connection (drop cache, reload); show last refresh time.
- REQ-EXPL-05 (MVP) Speed search: type-to-find in tree with highlight, up/down between matches, optional filter mode; operates on expanded nodes, with a "search all loaded nodes" option.
- REQ-EXPL-06 (MVP) Context actions: open data, show DDL, copy name, copy DDL, drop, truncate, rename (details in file 06).
- REQ-EXPL-07 (MVP) Quick info popup for table/column: schema, name, definition, row-estimate/size for PostgreSQL.
- REQ-EXPL-08 (MVP) Show DDL for an object, read-only, generated from catalog metadata; copy to clipboard and open in a new console.
- REQ-EXPL-09 (Later) Introspection depth setting (names only / full / full with routine source) with defaults chosen by object counts; per-schema override.
- REQ-EXPL-10 (Later) Auto-sync after DDL executed in the SQL editor, plus configurable timer.
- REQ-EXPL-11 (Later) Foreign key navigation: from a cell, open referenced/referencing rows; virtual FKs stored in app config.
- REQ-EXPL-12 (Later) Regex pattern filters for schemas and object-name filter syntax; item-type filter with visible "filter active" indicator.
- REQ-EXPL-13 (Later) ER diagram per schema/table with PK/FK edges, export to Mermaid/PNG.
- REQ-EXPL-14 (Later) Full-text value search across selected tables with first-N-per-table limit.
- REQ-EXPL-15 (Later) Structure compare of two schemas producing a reviewable migration script.
- REQ-EXPL-16 (MVP) Staleness: mark cached metadata that may be stale after a DDL error or reconnect and offer Refresh.

## Limitations / not verified

- No live UI capture of DataGrip was made; everything is from help-page text via a summarising fetch tool, so exact labels, ordering, icons and animations are unverified.
- The `#sync` Synchronize section, database-objects.html and database-diagrams.html were not obtained.
- The docs say nothing on PostgreSQL-specific catalog queries, network behaviour, caching format, or performance numbers beyond object-count thresholds.
- Cassandra, MongoDB, ClickHouse and other vendor-specific tree behaviour was not studied.
- Quick Documentation content for non-table objects (columns, routines) is not documented in the fetched pages.
- Items marked [ASSUMPTION] or listed as REQ-* are our design decisions, not observed DataGrip behaviour.
