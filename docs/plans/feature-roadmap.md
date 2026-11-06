# Feature Roadmap: What Is Still Missing

Date: 2026-10-22 · Baseline: commit `1619e4b` (M4.2 safe row editing)

This plan lists the features Quarry should have but does not yet have. It is built from three
sources:

- the requirements (`REQ-*`) in `docs/reverse-engineering/01`–`10`;
- the milestone plan in `docs/architecture/mvp-and-milestones.md`;
- a check of the code at the baseline commit (IPC commands, keymap, UI components).

Status markers:

| Marker  | Meaning                                                       |
| ------- | ------------------------------------------------------------- |
| Missing | Nothing in the code yet                                       |
| Partial | Some of the requirement is built; the gap is listed           |
| Done    | Built and tested (listed only where it frames a partial item) |

The global acceptance rules in `mvp-and-milestones.md` apply to every item below. In particular,
no control is rendered before it works, and every destructive or production-write path needs an
automated test proving the confirmation is required.

## 1. Where the product stands

Built (Phases 0 to 4.2): connection profiles with keyring secrets, test/connect/disconnect with
categorized errors, TLS modes, the lazy metadata tree, Monaco consoles backed by files, query
execution with cancel and error markers, the cursor-paged grid, CSV/JSON export, server-side
sort/filter, and safe row editing.

The backend exposes 26 IPC commands (`settings_*`, `workspace_*`, `connection*`, `sessions_list`,
`metadata_children`, `console_*`, `query_execute`, `query_cancel`, `result_*`). Everything below
needs new commands, new UI, or both.

## 2. Priority 1: finish Phase 4 (schema tools)

Phase 4 still lacks every schema tool. These are MVP requirements in file 06 and are the next
planned milestones.

### M4.3 Table viewer and richer metadata

- **Tree levels** (REQ-EXPL-01, Partial): add Keys (primary, unique, foreign), Check constraints,
  Triggers, Routines, and Sequences. Today the tree has schemas, Tables/Views/Materialized views,
  columns and indexes.
- **Table viewer**: a read-only tab with Columns, Indexes, Constraints, Foreign keys (both
  directions), Triggers, and size/row estimate.
- **Quick info** (REQ-EXPL-07, Missing): a popup for a table or column with schema, definition,
  row estimate and size.
- **Explorer context actions** (REQ-EXPL-06, Partial): today there are Refresh, Copy name,
  Connect/Disconnect, Properties, Duplicate, Delete. Add Open data, Show DDL, Copy DDL, and the
  Drop/Truncate/Rename entries from M4.5.
- **AC**: every new node kind loads lazily with parameterized catalog queries; integration tests
  cover each kind against the disposable server.

### M4.4 DDL generation

- **Show DDL** (REQ-EXPL-08, REQ-SCHEMA-09, Missing): generate DDL from the catalog in Rust
  for tables, views, materialized views, indexes, sequences, and functions.
  - Targets: clipboard, new console, file (native save dialog from Rust).
  - Options: schema-qualified names, skip owner/grants.
  - Multi-select generates one script in dependency order.
- **AC**: round-trip test: generate DDL for a seeded schema, apply it to an empty database, and
  compare the catalogs.

### M4.5 Create, modify, drop, truncate, rename

- **Create Table dialog** (REQ-SCHEMA-01, Missing): columns grid (name, type, not null, default,
  identity, comment), primary key, unique constraints, indexes, foreign keys (target, column
  pairs, ON DELETE/UPDATE, deferrable), and check constraints.
- **Live DDL preview** (REQ-SCHEMA-02, Missing): the preview regenerates on every form change. It
  can be edited as raw SQL, which shows an "edited manually" state and stops regeneration.
- **Modify Table** (REQ-SCHEMA-03, Missing): the same dialog prefilled from the catalog. The
  backend diffs the original and edited models and emits ALTER statements.
- **Transactional apply** (REQ-SCHEMA-04, Missing): run the script in one transaction, show
  per-statement errors, and roll back on failure.
- **Drop** (REQ-SCHEMA-05, Missing): confirmation lists the exact statements, with IF EXISTS,
  CASCADE and schema-qualify options. CASCADE or multiple objects require typing the name.
- **Truncate** (REQ-SCHEMA-06, Missing): explicit confirmation with RESTART IDENTITY and CASCADE
  options and a statement preview.
- **Rename** (REQ-SCHEMA-07, Missing): table/column/schema rename with an `ALTER ... RENAME`
  preview, then refresh the explorer.
- **Read-only enforcement** (REQ-SCHEMA-15): all schema tools are blocked on read-only sources.
  Production sources confirm with the statements.
- **Staleness** (REQ-EXPL-16, Missing): mark metadata as possibly stale after DDL runs or fails
  and after a reconnect, and offer Refresh.
- **AC**: every builder has unit tests (quoting, allow-listed type names, no values in SQL text);
  integration tests cover apply, rollback on a failing statement, and read-only rejection.

## 3. Priority 2: MVP gaps in modules already built

These modules work today but are missing parts of their MVP requirements. They should be closed
before or alongside Phase 5, since most of them change behaviour people rely on daily.

### M4.6 Transactions and sessions

The biggest functional gap. Today every console shares one session per data source and runs in
autocommit.

- **Transaction mode** (REQ-TX-01, REQ-EDIT-09, REQ-GRID-10, Missing): Auto/Manual per session,
  with an isolation level selector. Commit and Rollback buttons appear only in Manual mode, with a
  pending-transaction indicator in the toolbar and status bar.
- **Default mode per connection** (REQ-TX-02, Missing): applied to new consoles; the mode is
  logged with each execution.
- **Open-transaction guard** (REQ-ERR-09, Missing): warn before closing a tab, disconnecting, or
  quitting with an uncommitted transaction.
- **Session control** (REQ-SESS-01, REQ-CONN-13, Partial): shared or dedicated session per
  console, a "switch session" action, and a per-console current schema (`search_path`) selector
  that is restored on restart. Today: one session per data source and one job per source at a
  time.
- **Cancel escalation** (REQ-SESS-02, REQ-ERR-05, Partial): cancel works. Add the second stage,
  which offers to drop the connection, with a "may still run on the server" message.

### M4.7 Editor gaps

- **Parameter prompts** (REQ-EDIT-10, REQ-EXEC-03, Missing): detect `:name`, `${name}` and `$1`
  (configurable regexes, skipped inside strings and comments), prompt for values, and remember
  them per console.
- **Execution target policy** (REQ-EDIT-04, REQ-EXEC-01, Partial): a setting for what runs when
  the caret is outside a statement or the selection spans several statements, with an optional
  chooser popup.
- **Long-query notice** (REQ-EDIT-05, Partial): a notice after 20 s (configurable) and a
  notification when a long query finishes (REQ-ERR-08).
- **Completion** (REQ-EDIT-07, Partial): add functions, JOIN suggestions from foreign keys, and
  fuzzy/abbreviation matching. Keywords, schemas, tables, columns and aliases already work.
- **Schema resolution** (REQ-EDIT-11, Missing): a default schema selector per console, with
  `search_path` used to resolve unqualified names in completion.
- **NOTICE messages** (Missing): show server `RAISE NOTICE` output in the Output panel.
- **Output log** (REQ-ERR-01, Partial): add tx mode to each entry, plus search and clear.
- **Error navigation** (REQ-ERR-02, Partial): next/previous error and a hover tooltip on the marker.
- **Statement timeout** as a setting (Missing).

### M4.8 Result grid gaps

- **Copy formats** (REQ-GRID-16, Partial): today Ctrl+C copies one cell. Add multi-cell selection
  and Copy as TSV, CSV, JSON, SQL INSERT and Markdown, with "selection", "page" and "entire
  result" labelled separately.
- **Selection aggregates** (REQ-GRID-15, Missing): count, sum, avg, min and max for selected cells.
- **Columns** (REQ-GRID-06, Partial): resize works. Add hide/show and reorder, persisted per tab.
- **Row actions** (REQ-GRID-08, REQ-GRID-09, Partial): add Clone row and Revert for a selection
  (today only all changes, or a cell set back to its original value).
- **DEFAULT setter** for existing cells (REQ-GRID-07, Partial): new rows have `default`; edited
  cells only offer NULL.
- **Result tabs** (REQ-GRID-12, REQ-EXEC-02, Partial): pin a result tab, plus a reuse-or-new-tab
  setting.
- **Table browsing** (REQ-GRID-01, REQ-GRID-04, Missing): "Open data" from the explorer opens an
  editable grid on the table, with a free-form WHERE / ORDER BY filter bar and filter history.
- **Export** (REQ-IMPEX-07, REQ-IMPEX-08, Partial): add TSV, SQL INSERT and Markdown formats,
  NULL text and quoting options, a clipboard destination, and an export Cancel button.

### M4.9 Connection gaps

- **SSH tunnels** (REQ-CONN-07, Missing): host, port, user, auth (password, key file with
  passphrase, agent), optional local port, and reusable named SSH profiles. Passphrases go in the
  keyring like passwords.
- **Custom TLS files** (REQ-CONN-08, Partial): the modes work; add a CA file, client certificate
  and client key (PEM).
- **URL/DSN** (REQ-CONN-02, Missing): a derived, editable URL preview, and a "URL only" mode with
  a plaintext-secret warning.
- **Connection options** (REQ-CONN-06, Partial): keep-alive interval, auto-disconnect, connect
  timeout, and startup SQL.
- **Organization** (REQ-CONN-04, REQ-ENV-01, Partial): rename, reorder, folders, and colour
  inherited from the folder.
- **Schema scope** (REQ-CONN-09, REQ-EXPL-02, Missing): an "N of M schemas" checkbox selector
  with a pattern filter. Only selected schemas are introspected; new connections start with the
  default schema.
- **Failure dialog** (REQ-ERR-06, Partial): add a Test Connection button and a short checklist
  (reachability, credentials, TLS/SSH) to the connection error view.

### M4.10 Layout, navigation and explorer gaps

- **Editor tabs** (REQ-LAYOUT-04, Missing): pin, close others, reopen closed, overflow dropdown,
  and a path tooltip.
- **Consoles** (REQ-CONSOLE-01 to 03, Partial): rename, duplicate and delete consoles; scratch
  files not bound to a connection, with an "attach to connection" action.
- **Status bar** (REQ-LAYOUT-06, Partial): it shows the data source, session state and caret. Add
  current schema, transaction state and encoding.
- **Panels** (REQ-LAYOUT-02, Partial): Escape returns focus to the editor; a "hide all panels"
  toggle.
- **Search palette** (REQ-NAV-01, Missing): one palette for objects, consoles and actions, with a
  `/tables <name>` style filter and quick actions (open DDL, open data).
- **Navigation** (REQ-NAV-02, REQ-NAV-03, Missing): Go to DDL (Ctrl+B) from the tree and from
  identifiers in the editor, reveal in tree, back/forward history, and a recent consoles switcher.
- **Explorer** (REQ-TREE-01, REQ-EXPL-03 to 05, Partial): filter by item type, expand/collapse all,
  Force Refresh with the last refresh time, cancel for slow loads, and match-to-match navigation
  in speed search.

## 4. Phase 5: developer productivity

### M5.1 Query history

- **History store** (REQ-HIST-01, Missing): per-connection history in `app.db` with statement
  text, timestamp, duration, status/error, rows affected and session id; FTS5 search.
- **History popup** (Ctrl+Alt+E): search, insert into the editor, delete an entry.
- **Retention** (REQ-HIST-02, Missing): count and age limits (default 10,000 per connection,
  ADR-0004), a per-connection "disable history" option, and export to file.
- **AC**: history records every run, including failures and cancels; disabling history for a
  connection writes nothing for it (test asserts this).

### M5.2 Local file history

- **Revision history** (REQ-HIST-03, Missing): local revisions for each console file, with a diff
  view and restore.

### M5.3 Keymap and actions

- **Action registry** (REQ-KEY-01, Partial): `lib/keymap.ts` has 12 fixed commands. Make it a
  central registry of every action, with user-remappable bindings stored in settings.
- **Context and conflicts** (REQ-KEY-02, Missing): bindings resolved by the focused panel, and a
  conflict view in Settings.

### M5.4 CSV/JSON import

- **Import wizard** (REQ-IMPEX-01, Missing): CSV/TSV/pipe/semicolon from a file picker or by
  dropping a file onto a schema or table.
- **Format settings** (REQ-IMPEX-02, Missing): delimiter, quote, escape, record separator,
  header row, trim, encoding (UTF-8 with detection), NULL token, and saved presets.
- **Target and mapping** (REQ-IMPEX-03, REQ-IMPEX-04, Missing): append to an existing table or
  create a new one; map, ignore and reorder columns; infer types from a sample, with overrides.
- **Preview** (REQ-IMPEX-05, Missing): the first N parsed rows and the generated DDL, before any
  write.
- **Error policy** (REQ-IMPEX-06, Missing): abort, skip and log, or insert NULL; one transaction
  by default; an error list with line numbers.
- **Streaming** (REQ-IMPEX-12, Missing): stream-parse in Rust with bounded memory, progress and
  cancel. The file never passes through the WebView.
- **AC**: a 1M-row import stays within a fixed memory bound; an aborted import leaves no rows.

### M5.5 Snippets

- **Snippets** (REQ-SNIP-01, Later in file 08, but listed in Phase 5): abbreviation, variables,
  dialect scope, and import/export.

## 5. Phase 6: AI assistant

ADR-0005 sets the rules: the API key lives in the keyring, the user sees exactly what will be
sent, and AI output is never executed automatically.

### M6.1 Provider and settings

- **Provider abstraction** (REQ-AI-01, Missing): `crates/ai-core` with an `AiProvider` trait and
  `crates/ai-anthropic` calling the Messages API with streaming, from Rust only.
- **Settings**: API key (write-only, keyring), model selector, connection test.
- **Controls** (REQ-AI-11, REQ-AI-13, Missing): a global kill switch, per-workspace disable, an
  ignore list for tables and columns, and a plain statement of where data goes.

### M6.2 Consent and context

- **Context levels** (REQ-AI-06, Missing): None, Schema (selected or referenced objects), and
  later Schema + sample rows. Off by default; production sources default to None.
- **"What will be sent"** preview with a size estimate before every request.
- **Row data** (REQ-AI-07, Missing): never sent without a separate explicit consent; sample
  sizes capped and shown.
- **Request log** (REQ-AI-10, Missing): a local, viewable, clearable record of every request,
  with the key redacted.

### M6.3 AI actions

- **Natural language to SQL** (REQ-AI-02, Missing): output goes to a preview/diff pane and is
  inserted only on click.
- **Explain query / Explain error** (REQ-AI-03, Missing): statement and error text only, no rows.
- **Fix with AI** (REQ-AI-04, Missing): a corrected statement shown as a diff, applied on click.
- **Same execution guards** (REQ-AI-09, REQ-ERR-10): inserted SQL runs through the normal
  Execute path, including read-only, destructive and production checks.
- **Optimize query** (REQ-AI-05, Later): with optional EXPLAIN output attached by the user.

## 6. Phase 7: hardening and release

- Fault injection: network drop mid-query, permission denied, server restart.
- Large-result soak tests.
- Credential and execution-safety audit.
- Installers: AppImage/deb, MSI and dmg, with signing.
- Docs: setup per OS (including macOS), supported databases, limitations, release procedure.

## 7. Engineering work the features depend on

These are not user features, but several items above are risky without them.

| Item                            | Why it matters                                                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generated IPC bindings          | `ipc/types.ts` is written by hand. The M3.3 serde bug showed how Rust and TS drift. Generate bindings (`tauri-specta` or equivalent) before adding the many new commands above.         |
| UI end-to-end tests             | Playwright with mocked IPC and `tauri-driver` are planned but not set up. Schema tools and transactions need flow-level tests.                                                          |
| Secret scanning in CI           | ADR-0003 says gitleaks runs in CI; it does not yet. Add it before SSH keys and AI keys arrive.                                                                                          |
| Redacting logger                | M2.1 deferred it to "the first log statement". AI request logs and SSH need it (REQ-ERR-12).                                                                                            |
| macOS and Windows CI            | CI runs on Ubuntu only, and the README covers Linux only. The project is also developed on macOS.                                                                                       |
| Unreliable explorer timing test | `explorerTree.test.tsx` "expands a 1,000-table level within the 1 s budget" fails when the full suite runs in parallel on macOS and passes alone. Loosen the bound or isolate the test. |
| Docs drift in `overview.md`     | Lists crates that do not exist (`exec`, `metadata`, `sql`); the splitter and classifier live in TypeScript (`lib/sql/`), not Rust as REQ-EDIT-03 says. Update or record the decision.   |
| Tree virtualization             | Deferred at 1,000 rows. Schema scope (M4.9) and larger catalogs may need it.                                                                                                            |

## 8. Suggested order

Each item below has a detailed, trackable plan in this folder; see the
[tracker](README.md#tracker) for step numbers, dependencies and progress.

1. **Generated IPC bindings**, then **M4.6 Transactions and sessions**. Transactions change how
   execution, the grid, schema tools and the status bar behave, so they should land before more
   features build on today's autocommit model.
2. **M4.3 to M4.5 Schema tools**, which finish Phase 4.
3. **M4.8 Grid** and **M4.7 Editor** gaps, which are high-use daily features.
4. **M5.1 Query history** and **M5.3 Keymap**.
5. **M4.9 Connections** (SSH tunnels and TLS files first) and **M4.10 Navigation**.
6. **M5.4 Import**, **M5.2 File history**, **M5.5 Snippets**.
7. **Phase 6 AI**, after the redacting logger and secret scanning are in place.
8. **Phase 7 hardening and release**.

## 9. Later backlog

Requirements marked Later in the workflow docs, kept here so they are not lost:

- Layout: drag and undock panels, editor split, preview tabs (REQ-LAYOUT-03, REQ-LAYOUT-05).
- Navigation: bookmarks, structure popup (REQ-NAV-04).
- Explorer: introspection levels and auto-sync after DDL, FK navigation and virtual FKs, regex
  filters, ER diagrams, full-text value search, schema compare (REQ-EXPL-09 to 15, REQ-CONN-10).
- Schema: rename across consoles, edit routine/view source with a diff, schema compare migration
  scripts, naming templates, safe-delete analysis with `pg_depend` (REQ-SCHEMA-08, 10 to 14).
- Editor: formatter style schemes, inspections, EXPLAIN tree view, playground/script resolve
  modes, per-console dialect (REQ-EDIT-12 to 16).
- Grid: value editor panel, transpose and tree view, per-column local filter, FK related rows,
  compare results (REQ-GRID-05, 13, 14, 17).
- Import/export: Excel, Parquet, JSON lines, pg_dump front-end, disabling triggers during bulk
  import (REQ-IMPEX-09 to 11).
- Connections: driver-specific connection types, export/import of definitions without secrets
  (REQ-CONN-11, REQ-CONN-12).
- Other engines: MySQL/MariaDB and SQLite adapters, listed as supported only after the adapter
  contract suite passes.
