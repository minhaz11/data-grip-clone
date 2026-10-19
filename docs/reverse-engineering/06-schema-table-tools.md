# 06 — Schema and Table Tools

## Sources

All fetched 2026-10-19 from the official DataGrip help (documentation labelled 2026.2). Content came through a fetch tool that returns a model-written summary of each page, so wording is paraphrased and details may be lost.

- https://www.jetbrains.com/help/datagrip/working-with-the-data-editor.html (titled "Tables")
- https://www.jetbrains.com/help/datagrip/create-and-modify-dialogs.html
- https://www.jetbrains.com/help/datagrip/columns.html
- https://www.jetbrains.com/help/datagrip/foreign-keys.html
- https://www.jetbrains.com/help/datagrip/indexes.html
- https://www.jetbrains.com/help/datagrip/virtual-foreign-keys.html
- https://www.jetbrains.com/help/datagrip/confirm-drop-dialog.html
- https://www.jetbrains.com/help/datagrip/rename-dialog-for-a-table-or-column.html
- https://www.jetbrains.com/help/datagrip/refactoring-source-code.html
- https://www.jetbrains.com/help/datagrip/modifying-source-code-of-database-objects.html
- https://www.jetbrains.com/help/datagrip/rows.html (Truncate, delete rows)
- https://www.jetbrains.com/help/datagrip/export-data.html (DDL / SQL Generator sections only)
- https://www.jetbrains.com/help/datagrip/database-explorer.html
- https://www.jetbrains.com/help/datagrip/schema-comparison-and-migration.html
- https://www.jetbrains.com/help/datagrip/databases.html
- https://www.jetbrains.com/help/datagrip/schemas.html
- https://www.jetbrains.com/help/datagrip/submitting-and-reverting-changes.html
- https://www.jetbrains.com/help/datagrip/code-inspection.html

Fetch failures: none of the above failed, but `database-objects.html` returned an empty body and was excluded. No dedicated Truncate dialog page and no "safe delete" page for database objects were found in the docs I fetched.

## Evidence legend

- [DOC] stated in fetched official docs.
- [CFG]/[REA] local observation (none supplied for this topic).
- [ASSUMPTION] our inference, not verified.

## Observed workflows

1. **Create a table.** Database Explorer: right-click a database or schema node, New | Table. [DOC]
   - A non-modal Create dialog (non-modal since 2024.3) has three regions: table-structure tree (upper left), object editor (upper right), Preview (bottom). [DOC]
   - Enter a Name; configure columns, keys, indexes, foreign keys, grants; table-level Comment and Owner fields exist. [DOC]
   - Tree toolbar: Add (Alt+Insert), Edit (F4), Edit On Selection toggle, Remove (Alt+Delete), Back/Forward (Ctrl+Alt+Left/Right). Double-clicking a family node lists similar objects; editor tabs can be pinned. [DOC]
   - Create and Modify dialogs share fields and behaviour; available properties vary by vendor and come from introspected metadata. [DOC]
   - The Tables page does not list a Checks tab for the create flow, but the dialogs page lists Checks (Name, Comment, Predicate) among table objects. [DOC; the two pages differ in emphasis]

2. **Preview generated DDL before applying.** The Preview pane shows the SQL that will run on OK; it can be edited directly, so the user can hand-write SQL there. A Settings button sets run options and an Open-in-console button closes the dialog and moves the script into a query console. [DOC]
   - Each smaller dialog (new column, index, foreign key) also has a Preview pane. [DOC]

3. **Modify a table.** Right-click table, Modify Table (introduced 2022.1) or select and press Ctrl+F6. [DOC]
   - Fields are generated from introspected metadata, so they differ by database: PostgreSQL permits column check constraints; Auto Increment shows only where supported (SQLite, MySQL integer primary keys). [DOC]
   - OK saves, i.e. runs the generated ALTER script shown in Preview. [DOC]

4. **Add / modify a column.** Table | New | Column, enter Name, review Preview, OK; existing column via Modify Column. [DOC]
   - Column properties: Name, Comment, Data Type, Not Null, Default Expression, auto-generated value (default, sequence or auto-increment depending on DBMS). [DOC]
   - SQLite supports only a subset of ALTER TABLE (rename table, rename column, add column); deleting a column goes through Modify Table, where the IDE recreates the table without it. [DOC]
   - General column rename procedure is not stated on the Columns page. [DOC]

5. **Keys, indexes, foreign keys.** [DOC]
   - New | Index on a table or column node: Name, Columns pane (Column Name, Order, Collation), Unique checkbox, Comment, Preview. MongoDB indexes can only be shown and dropped.
   - Primary key: Name, Comment, Primary checkbox, Columns pane. Creation steps not given on the Indexes page.
   - New | Foreign Key: Name, Target Table, Columns pane (child column to target column), Deferrable, Initially Deferred, On Delete / On Update actions (listed on the dialogs page; the Foreign keys page itself did not mention referential actions), Preview.
   - Default constraint/index names come from templates under Editor | Code Style | SQL | General | Code Generation, e.g. `{table}_{columns}_{unique?u:}index` and `{table}_{columns}_pk`.
   - Virtual foreign keys: New | Virtual Foreign Key, stored in `external-data-<datasource>.xml`, not created in the database; also virtual columns and virtual views.

6. **Drop an object.** Right-click, Object Actions | Drop… or press Delete; the Confirm Drop dialog opens. [DOC]
   - Options: Qualify objects with schema names (Auto = only when same-named objects exist across schemas / Never / Always), Use IF EXISTS, Use DROP CASCADE (removes dependents such as views), Reformat generated code. [DOC]
   - Preview shows the exact statements, editable; OK runs them; "Open query in console" copies them to a console instead. [DOC]
   - For folders and data sources the 2026.2 flow lists items to delete and asks confirmation (reported in release notes seen only via search snippet, not fetched; treat as unverified).

7. **Truncate.** Right-click a table, Object Actions | Truncate…; available for tables only. The fetched docs do not describe the dialog's options or confirmation. [DOC for the menu path; options not documented]
   - [ASSUMPTION] Truncate is irreversible in most engines, so our dialog must confirm explicitly.
   - Delete rows (different feature): select rows, Delete Row / Ctrl+Y / Delete, then Submit; transaction mode decides when it commits; no confirmation dialog is documented. [DOC]

8. **Rename.** Select object, Object Actions | Rename or Shift+F6; the Rename dialog holds New name, Search in loaded sources, Search for text occurrences, Search in comments and strings, Scope (recent files, open files, custom shared or local), editable Preview of the rename statement, and Preview / Refactor buttons (Preview lists usages; Refactor applies immediately). [DOC]
   - The Preview shows a statement that renames the table or column, implying the rename runs against the database. [DOC for the Preview; the implication is [ASSUMPTION]]
   - Refactoring Preview lets you exclude individual usages, then Do Refactor. [DOC]
   - Other refactorings documented: rename in place from the gutter, extract variable (Ctrl+Alt+V), subquery as CTE, extract routine (Ctrl+Alt+M). "Safe delete" and "change signature" are not documented on the fetched page. [DOC]

9. **Edit routine/view source.** Ctrl+B (Go to DDL), edit, Submit (Ctrl+K); the Object Migration dialog shows the generated migration script for review before OK; changes tracked in the Database Changes tool window with a diff viewer. Conflicts offer Force Refactoring or Abort and Synchronize, then Revert / Keep / Merge. Colours: black in sync, blue modified, red conflicting. [DOC]

10. **Generate SQL statements.** SQL Generator (Ctrl+Alt+G) outputs DDL with qualified names and CREATE OR REPLACE where relevant; Generate DDL to Clipboard / Query Console; MySQL/MariaDB "Skip DEFINER clause" option; "Request and Copy Original DDL". Copy structure only via SQL Generator; copy data and structure via drag or Import/Export | Copy Table to… (F5). [DOC]

11. **Compare and migrate.** Select two same-kind objects, Compare Structure With (Ctrl+D): Origin/Target panels, colour-coded Added / Modified / To be deleted, per-change checkboxes, Script Preview, Execute or Open Query in Console. Options include qualify names, allow object recreation, ignore owner/grants/order, reformat output. [DOC]

12. **Read-only guard in the data editor.** The lock icon makes a table read-only in the data editor only; consoles and explorer actions can still modify it. [DOC]

13. **Table quick info.** Ctrl+Q on a table shows its definition; "Show table preview" shows data (and size for PostgreSQL/MySQL). [DOC]

## Keyboard shortcuts

| Action                               | Windows/Linux           | Source |
| ------------------------------------ | ----------------------- | ------ |
| Modify object                        | Ctrl+F6                 | [DOC]  |
| Rename                               | Shift+F6                | [DOC]  |
| Drop selected object                 | Delete                  | [DOC]  |
| Add element in Create/Modify dialog  | Alt+Insert              | [DOC]  |
| Edit element in dialog               | F4                      | [DOC]  |
| Remove element in dialog             | Alt+Delete              | [DOC]  |
| Back / Forward in dialog             | Ctrl+Alt+Left / Right   | [DOC]  |
| New (explorer)                       | Alt+Insert              | [DOC]  |
| Go to DDL                            | Ctrl+B                  | [DOC]  |
| Submit source edits                  | Ctrl+K                  | [DOC]  |
| SQL Generator                        | Ctrl+Alt+G              | [DOC]  |
| Compare structure                    | Ctrl+D                  | [DOC]  |
| Copy table to                        | F5                      | [DOC]  |
| Introduce variable / extract routine | Ctrl+Alt+V / Ctrl+Alt+M | [DOC]  |
| Delete row in data editor            | Ctrl+Y or Delete        | [DOC]  |

## Edge cases and error states

- Preview is editable, so the executed SQL can diverge from the GUI state; the GUI form is only a generator. [DOC]
- Vendor limits: SQLite recreates a table to drop a column; MongoDB indexes show/drop only; Auto Increment only on supporting vendors. [DOC]
- DROP CASCADE removes dependents beyond the selection; the preview is the safeguard. [DOC]
- Qualifying names matters when saving a DROP script for later; running at once makes it moot. [DOC]
- Cached object out of date: notification, conflict dialog on submit, Force Refactoring overwrites others' changes. [DOC]
- Source is only editable if it was loaded (Load Sources None disables it); Go to DDL output may not run as-is (unqualified). [DOC]
- Schema-compare scripts: only same-type objects; "Allow object recreation" used only when ALTER is impossible; ignoring implicit objects hides those differences. [DOC]
- Read-only lock does not protect from console or explorer changes. [DOC]
- Truncate dialog contents and drop-folder confirmations were not verified in primary docs. [not verified]
- Undo in diagrams does not revert changes already applied through Modify. [DOC]

## Implementation requirements for our app

Design target: Rust backend executes generated DDL on PostgreSQL first; React dialogs mirror a form-to-SQL generator.

- REQ-SCHEMA-01 (MVP) Create Table dialog: name, schema, columns grid (name, type, not null, default, identity/serial, comment), primary key, unique/indexes, foreign keys (target table, column pairs, ON DELETE/UPDATE, deferrable), check constraints.
- REQ-SCHEMA-02 (MVP) Live DDL preview pane, regenerated on each form change; editable as raw SQL with a visible "edited manually" state that stops regeneration; Run in console option.
- REQ-SCHEMA-03 (MVP) Modify Table uses the same dialog, prefilled from catalog; the backend diffs original versus edited model and emits ALTER statements (add/drop/alter column, constraints, indexes); show the whole script before OK.
- REQ-SCHEMA-04 (MVP) Execute generated script in one transaction where the engine allows (PostgreSQL DDL is transactional); show per-statement errors and roll back on failure.
- REQ-SCHEMA-05 (MVP) Drop confirmation dialog listing exact statements, with options IF EXISTS, CASCADE, schema-qualify (auto/always/never); multi-select drop; require typing name for CASCADE or multiple objects ([ASSUMPTION] stricter than DataGrip).
- REQ-SCHEMA-06 (MVP) Truncate action for tables with explicit confirmation, option RESTART IDENTITY and CASCADE, and a preview of the statement; disabled for read-only connections.
- REQ-SCHEMA-07 (MVP) Rename table/column/schema via dialog with preview of `ALTER ... RENAME`; refresh explorer after.
- REQ-SCHEMA-08 (Later) Rename refactoring across open consoles (find usages) with an excludable usage list.
- REQ-SCHEMA-09 (MVP) Generate DDL for one or many objects to clipboard / console / file, with qualified names and a "skip owner/grants" option.
- REQ-SCHEMA-10 (Later) Edit routine/view source with a diff view, submit as CREATE OR REPLACE, and stale-source conflict detection comparing against live catalog text.
- REQ-SCHEMA-11 (Later) Schema compare producing a migration script with per-change checkboxes and options (ignore owner, grants, order).
- REQ-SCHEMA-12 (Later) Virtual foreign keys stored in app config (not in the database) and used by completion/navigation.
- REQ-SCHEMA-13 (Later) Naming templates for generated index/constraint names (table, columns, unique placeholders).
- REQ-SCHEMA-14 (Later) Safe-delete analysis (list dependents before drop) — not documented for DataGrip; our own feature using `pg_depend` ([ASSUMPTION]).
- REQ-SCHEMA-15 (MVP) Per-connection read-only mode that blocks all DDL/DML from schema tools, not just the grid (stricter than DataGrip's data-editor-only lock [DOC]).

## Limitations / not verified

- No live UI capture of DataGrip was made; every [DOC] item rests on summarised help text. Exact labels, tab names, field order and default checkbox states are unverified.
- Truncate dialog options and any confirmation text are not documented in the fetched pages; the 2026.2 folder-deletion confirmation came only from a search snippet and was not fetched.
- "Safe delete" for database objects, change-signature, and column-rename procedure are not documented in the fetched pages.
- Which ALTER statements DataGrip emits for PostgreSQL, how it orders operations, and how it handles failures mid-script are undocumented.
- Check constraint UI in Create Table is mentioned inconsistently across pages (Tables page vs dialogs page).
- REQ-* items beyond what the docs state are our design decisions, not observed behaviour.
