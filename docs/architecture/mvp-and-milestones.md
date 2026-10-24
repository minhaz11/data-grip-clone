# MVP Definition, Milestones, and Acceptance Criteria

## MVP (end of Phase 3, PostgreSQL only)

A developer can:

1. Create, test, and save a PostgreSQL connection with its password in the OS keyring.
2. Browse schemas, tables, views, columns, indexes, and constraints lazily.
3. Write SQL in a tabbed Monaco console with highlighting and schema-aware completion.
4. Run the current statement, the selection, or the whole script without freezing the UI.
5. Cancel a running query.
6. See the results in a virtualized, paged grid, with errors pointing at line and column.
7. Export results to CSV or JSON.
8. Reopen the app with the same tabs and connections.

Out of MVP: data editing (Phase 4), DDL tools (Phase 4), history/snippets/import (Phase 5),
AI (Phase 6), other engines (after PostgreSQL is stable), installers (Phase 7).

## Milestones

Each milestone is small enough to verify on its own. "Done" means the acceptance checks pass and the
listed tests run green in CI.

### Phase 0 — Discovery and architecture ✅ (this milestone)

- [x] Environment inventory, REA capability check, and evidence
      (`docs/reverse-engineering/00-methodology-and-evidence.md`).
- [x] Workflow findings `01`–`10` from official docs, config, and REA.
- [x] ADR-0001…0005, architecture overview, and this plan.

### Phase 1 — Desktop foundation

- **M1.1 Toolchain + scaffold**: rustup, system dev packages, Tauri 2 + React/TS/Vite/Tailwind,
  Cargo workspace, ESLint/Prettier, rustfmt/clippy, Vitest, CI workflow.
  - **AC**: `npm run tauri dev` opens a window on Linux.
  - **AC**: `npm test`, `cargo test`, `cargo clippy -D warnings`, and `npm run lint` all pass.
- **M1.2 Shell layout**: left explorer, centre editor tabs, bottom results/messages, toolbar, status
  bar. Panels are resizable and collapsible, with sizes persisted.
  - **AC**: keyboard-reachable; no axe violations; layout restores after restart.
- **M1.3 Settings + theme**: `store` crate with migrations; settings commands; light/dark/system theme.
  - **AC**: the theme persists; migration tests pass on an empty DB and an upgraded DB.

### Phase 2 — PostgreSQL connectivity

- **M2.1 Connection profiles** ✅: CRUD, duplicate (copies the password, per [DOC] 02), environment
  tag + colour, read-only flag, keyring secrets with save modes Forever / Until restart / Never.
  - **AC**: no secret appears in `app.db`, logs, or any IPC response (test asserts this).
  - Done: `quarry-secrets` (keyring + memory stores, `SecretString` is not `Serialize`),
    `quarry-store` migration 2, `quarry-connections` (rollback on keyring failure, secret moves on
    save-mode change, delete aborts if the keyring refuses). A canary test scans `app.db`/WAL bytes,
    serialized profiles and `Debug` output. There is no logging framework yet; the redacting logger
    arrives with the first log statement.
- **M2.2 Test connection + lifecycle** ✅: test with timeout; categorized actionable errors; connect/
  disconnect; SSL modes.
  - **AC**: each error category is reproduced against the disposable container (or a closed port) and
    shown with a hint.
  - Done: `quarry-db-core` (contract, `ConnectError` kinds with hints) and `quarry-db-postgres`
    (DNS pre-resolution, overall timeout, libpq-style TLS: prefer/require encrypt without
    verification, verify-ca checks the chain, verify-full also the host name; read-only via
    `default_transaction_read_only`). Integration tests (`scripts/test-pg.sh`, 127.0.0.1:55432 only)
    reproduce: refused, DNS, timeout (TEST-NET-1 blackhole), auth, password required, database
    missing, TLS (self-signed vs verify-ca/full), plus TLS on/off success, read-only, and
    deliberate vs server-side session close. `server_unavailable` is covered by a SQLSTATE unit
    test only (hard to provoke reliably). Session registry emits `connection-status` events;
    the UI shows status dots, Connect/Disconnect, a password prompt, and copyable error details.
  - Not yet: custom CA / client certificates (REQ-CONN-08) and SSH tunnels (REQ-CONN-07) came
    in M4.9.
- **M2.3 Metadata tree** ✅: lazy schema → kind → object → children; refresh; filter.
  - **AC**: 1,000-table schema expands in < 1 s after the first load; refresh picks up a new table.
  - Done: engine-neutral `MetadataRequest`/`MetaNode` (each node carries the request for its
    children); PostgreSQL catalog queries for schemas, Tables/Views/Materialized views (counts),
    objects, columns (type, default, pk, not null) and indexes (definition, primary/unique), all
    parameterized. Measured: 1,000 tables load in ~25 ms from the disposable server; the UI renders
    the 1,000-row level well under the 1 s budget in jsdom (an upper bound for WebKit). Refresh
    (Ctrl+F5) keeps expansion and reloads visible levels; filter searches loaded nodes and reveals
    their ancestors; a lost or closed session clears that source's tree. Keyboard: ↑/↓/Home/End,
    → expand/enter, ← collapse/parent, Enter, Shift+F10.
  - Not yet: DDL view (Phase 4; keys, foreign keys, routines and sequences came in M4.3), tree virtualization (not
    needed at 1,000 rows; revisit with the WebKitGTK budget test in Phase 3).

### Phase 3 — SQL execution

- **M3.1 Editor** ✅: Monaco tabs/consoles backed by files; PostgreSQL highlighting; format;
  completion for keywords, schemas, tables, and columns.
  - Done: Monaco 0.57 bundled locally (generated entry with only editor features plus the pgsql
    tokenizer; lazy 4 MB chunk; local worker). One model per tab keeps undo and view state.
    Consoles are `.sql` files under `<app_data>/consoles/`, addressed by validated names
    (`quarry-workspace`: create-new, atomic writes, 16 MB cap), with 400 ms autosave and a flush on
    close or hide. Pre-M3.1 inline text is migrated into files once (StrictMode-safe). Each
    console is bound to a data source (toolbar picker; tab shows its colour).
  - Format with Ctrl+Alt+L or the toolbar (sql-formatter, PostgreSQL dialect, keeps keyword
    case, undoable, parse errors shown inline).
  - Completion: a lexer-aware statement splitter (quotes, E-strings, dollar quotes, nested
    comments) finds the current statement. The context detects relations / `alias.` /
    `schema.`, and aliases resolve to tables. The catalog is one `Relations` query per source,
    plus columns per table on demand, cached until the session changes. It never connects by
    itself: without a live session, keywords only. Identifiers are quoted only when needed.
  - Found while verifying: Tauri `freezePrototype` breaks Monaco at load; disabled, with the
    trade-off recorded in `docs/security/dependency-advisories.md`. The lazy editor sits behind
    an error boundary with Retry.
- **M3.2 Execution** ✅: current/selection/script; job events; timing; cancel; error position →
  editor marker.
  - **AC**: `SELECT pg_sleep(30)` cancels within 1 s, and the UI stays responsive throughout.
  - **AC**: a syntax error underlines the right token.
  - Done:
    - Statements run one at a time over the simple-query protocol. Values arrive as text (exact
      numeric/int8/timestamps, every type works), with column types from a describe-only
      prepare. The first 500 rows are kept and the rest counted; long cells are clipped and
      marked.
    - Scripts stop at the first error. Cancel is out-of-band (`CancelToken`); SQLSTATE 57014
      maps to "cancelled".
    - Jobs stream to the console that started them over a Tauri `Channel`, one job per data
      source at a time.
    - The splitter in `lib/sql/statements.ts` picks the selection, current statement, or script.
      Ctrl+Enter runs, Ctrl+Shift+F10 runs the script, Ctrl+F2 stops.
    - Error positions become a Monaco marker plus a clickable line:column in Output.
    - Safety guards run before anything is sent. A statement classifier (CTE writes,
      `EXPLAIN ANALYZE`, DELETE/UPDATE without WHERE, DROP/TRUNCATE/ALTER … DROP) drives them:
      read-only sources block writes client-side (and server-side via
      `default_transaction_read_only`); destructive statements and production writes need
      confirmation, with Cancel focused. The same path will serve AI-generated SQL.
    - Integration tests (disposable server): typed exact values, cap and count, affected rows,
      error positions, cancel < 1 s with the session reusable, read-only rejection.
  - Later: per-console sessions and transaction mode controls came in M4.6; NOTICE messages
    and the statement timeout setting in M4.7; query history in M5.1.
- **M3.3 Grid + export** ✅: virtualized paged grid; multiple result tabs; CSV/JSON export streamed from
  the backend.
  - **AC**: a 1M-row result never sends more than 2 pages over IPC at once; it scrolls smoothly in
    WebKitGTK; the exported file matches row count and content.
  - Done:
    - **Query results stay in a `SCROLL … WITH HOLD` cursor.** It is materialized once, outside
      any transaction, so no locks or snapshot are held while browsing and user `BEGIN`s are
      unaffected. The count is exact (`MOVE ALL`), and any page is reached with
      `MOVE ABSOLUTE n; FETCH n`.
      - Analysis-time `DECLARE` failures (SQLSTATE 42/0A) re-run directly, which is safe because
        nothing executed and positions stay correct. Runtime errors are never retried.
      - The backend accepts only cursors it created, capped at 16 per session. A cursor dropped
        by the user's `ROLLBACK` reads as "run again".
      - Measured (1M rows): first page about 0.7 s, any later page about 40 ms.
    - **Grid:** fixed-height virtual rows with scroll scaled beyond 8M px; a 500-row page cache
      (LRU 24 pages); at most 2 pages per viewport (tested); resizable columns; keyboard cell
      navigation; Ctrl+C copy; `role="grid"` semantics. Results that cannot be paged
      (`RETURNING`, `SHOW`) say so and are capped.
    - **Export:** the native save dialog opens from Rust, so the path never comes from the
      WebView. Cursor pages (5,000 rows) go through a bounded queue to a writer thread, the file
      is written as `.partial` and renamed on success, and progress streams over a `Channel`.
      CSV keeps NULL distinct from `""`; JSON is lossless for numbers, booleans and json/jsonb
      (`quarry-io`). An end-to-end test exports 100k rows and checks counts and content.
    - **Cursor lifetime:** cursors are closed when a console re-runs or closes.
  - **Bug found and fixed:** serde `rename_all` on internally tagged enums renames only variant
    tags. `StatementOutcome`/`ExecEvent` fields went out snake_case, breaking M3.2's Output
    summaries and timings (the Result tab hid it). Fixed with `rename_all_fields`, plus
    Rust-side JSON contract tests.
  - Later: sorting/filtering came in M4.1; export cancel, TSV/SQL INSERT/Markdown, NULL text
    and quoting options in M4.8.

### Phase 4 — Data and schema management

- **M4.1 Server-side sort/filter** ✅ (WHERE/ORDER BY builders with bound values).
  - The query re-runs as `SELECT * FROM (<query>) AS q(c1…cn) WHERE … ORDER BY <positions>`.
    The positional alias list handles duplicate or odd column names, the original sits on its
    own lines (trailing comments are safe), and every identifier is generated.
  - Values are bind parameters cast to the column type (`($1::text)::int4`), so bad input gets
    PostgreSQL's own message. Contains/starts-with use `ILIKE … ESCAPE` with `%`/`_` escaped.
    Type names are allow-listed; anything else compares as text.
  - The result is a fresh cursor (paging and export keep working), and the old cursor is closed.
    A failed re-run keeps the previous result and shows the error.
  - UI: click a header to sort (asc → desc → off), Shift+click for multi-column (numbered
    indicators, `aria-sort`). The filter bar has removable chips and an inline
    column/operator/value form. Column widths survive re-runs. Results that cannot be re-run
    show no controls.
  - Tests: builder unit tests (no values in SQL text, unsafe type names, limits) and integration
    tests (numeric vs text order, typed timestamp filters, literal `%`/`_`, NULL tests, duplicate
    names, CTEs with inner ORDER BY, 22P02 messages, injection as a plain value).
  - Paging controls: superseded by the virtual scroller over cursor pages (M3.3).
- **M4.2 Safe row editing** ✅
  - **Editability** comes from the server's column origins (RowDescription table OID and
    attnum) and the catalog, never from SQL text. A result is editable only when its columns come
    from one base table (not a view or temp table) with a primary key that is fully present in
    the result. Otherwise the edit bar shows why: several tables, no primary key, missing key
    columns, computed columns only, a view, a temp table, or a read-only data source.
  - **Pending changes** are keyed by primary-key values (stable across paging and re-sorts):
    edited cells amber, deleted rows red and struck through, new rows green with `default`
    placeholders. Editing back to the original drops the change. Keys: double-click, F2 or Enter
    to edit (Enter saves and moves down, Tab moves right, Esc cancels, a NULL button sets NULL);
    Delete toggles deletion; Insert adds a row.
  - **Preview** shows the exact statements and bound values from the same Rust builder Submit
    uses. Identifiers come from the catalog, always quoted; values are bound and cast; type names
    are allow-listed.
  - **Submit** runs one transaction on a **separate short-lived connection**, so an open
    console `BEGIN` is never committed or mixed in. Each update/delete must affect exactly one
    row, and updates also require the edited columns to still hold their original values
    (`IS NOT DISTINCT FROM`, optimistic lock). Any mismatch or server error rolls everything
    back, with a "Change N of M" message. Production sources confirm with the statements;
    read-only sources are blocked (and the server rejects writes anyway). After a submit the
    result is re-read with the same sort and filter.
  - Tests: builder unit tests (no values in SQL, unsafe types, key checks) and integration tests
    (editability reasons, apply/conflict/rollback, per-change errors, isolation from an open
    console transaction, read-only rejection).
- **M4.3 Table viewer and richer metadata** ✅ (plan: `docs/plans/04-table-viewer-metadata.md`)
  - **Tree**: under a table, Columns plus Keys, Foreign keys, Checks, Indexes and Triggers; under
    a schema, Routines (user functions and procedures, overloads apart by their identity
    arguments; extension members left out) and Sequences (type, increment, owning column).
    Empty groups are hidden, except Columns. Details come from the server's own definitions
    (`pg_get_constraintdef`, `pg_get_triggerdef`, `pg_get_function_identity_arguments`).
  - **Table viewer**: Enter or double-click on a table, view or materialized view opens a
    read-only tab (editor tabs are now consoles or objects, both restored on restart) with
    columns (type, nullability, default, identity or generation, comment, primary key),
    indexes, constraints, foreign keys in both directions, triggers, row estimate and size, and
    Refresh. Offline it offers Connect; a dropped object says so.
  - **Quick info** (Ctrl+Q or the context menu) for tables, views and columns.
  - One `object_details` command reads the whole object by OID with parameterized catalog
    queries; checked field by field against `psql \d+` on the seeded `shop.orders`.
  - Tests: integration (every new kind, overloads, owned sequences, both FK directions, identity
    and generated columns, comments, estimates, a missing object); UI (viewer sections, Connect,
    quick info, tab de-duplication and restore); E2E axe scan of the viewer.
  - Not yet: Open data (M4.8), partitions as children of their parent.
- **M4.4 DDL generation** ✅ (plan: `docs/plans/05-ddl-generation.md`)
  - **Show DDL / Copy DDL** on tables, views, materialized views, routines, sequences, indexes,
    triggers and whole schemas. The DDL tab is read-only (Monaco), with Qualified names / Owner /
    Grants options, Copy, Open in console and Save (native dialog from Rust, written atomically).
  - **Generated in Rust from the catalog** on a short-lived side connection with its own
    `search_path`, so a console's open transaction is never touched and the server qualifies and
    quotes every name the same way (`regclass`, `pg_get_*def`, `quote_ident`, `quote_literal`).
  - **Order that applies cleanly**: schemas, sequences, routines (row-type routines after
    tables), tables without foreign keys (partitions after parents), views in dependency order,
    sequence ownership, indexes, foreign keys (so circular pairs work), triggers. Serial
    sequences come with their table.
  - **Round-trip tests**: the seeded `shop` schema and a rich fixture (identity and generated
    columns, collations, partial and expression indexes, circular FKs, partitions, chained views,
    materialized views, functions, a procedure, enabled and disabled triggers, odd identifiers,
    comments) are generated, applied to an empty database and generated again: the text and a
    catalog fingerprint of the two databases must match. The fingerprint caught a partitioned
    index written as `ON ONLY`, which would have left partitions unindexed.
  - Also fixed: SQL syntax colors below 4.5:1 contrast in the editor (strings and operators in
    light, comments, strings and predefined variables in dark), now scanned in both themes.
  - Not yet: aggregates (emitted as a comment), table inheritance (`INHERITS`), arbitrary
    multi-select in the explorer (schema-level generation covers multiple objects).
- **M4.5 Schema change tools** ✅ (plan: `docs/plans/06-schema-change-tools.md`)
  - **New table / Modify table** from the explorer: columns (type with suggestions, not null,
    default, identity, comment), primary key, uniques, checks, foreign keys and indexes. Modify
    starts from a `TableModel` read from the catalog and diffs it against the edit; column
    renames carry through keys, and an unchanged model produces no statements.
  - **Drop** (IF EXISTS, CASCADE), **Truncate** (RESTART IDENTITY, CASCADE) and **Rename**
    (table, column, schema) for every object kind the explorer shows.
  - **Exact statements first**: every dialog shows a live preview built in Rust; Edit SQL
    switches to hand-edited text (Reset to generated returns), which runs through the console's
    destructive-statement check.
  - **All or nothing**: apply runs in one transaction on a short-lived side connection; a failure
    reports "Statement N of M failed" with the statement and changes nothing.
  - **Guards**: read-only sources offer no schema tools and the server rejects the transaction;
    production sources confirm with the statements; CASCADE or several objects require typing
    the name. After apply the explorer refreshes; DDL run in a console marks the source out of
    date with a Refresh button.
  - Tests: Rust unit (builders, quoting, type grammar, diff order); integration (create with every
    constraint kind compared with the catalog, alter kinds, no-op model, rollback on failure,
    read-only rejection, drop/truncate/rename); UI (create, typed CASCADE confirmation, a
    production confirmation for each tool, hand edits, modify from the model, read-only, stale
    banner); E2E (table dialog).
  - Not yet: `USING` for type changes (via Edit SQL), view/routine source editing, rename
    refactoring, safe-delete analysis.
- **M4.6 Transactions and sessions** ✅ (plan: `docs/plans/03-transactions-sessions.md`)
  - **Transaction state comes from the server.** `tokio-postgres` drops the ReadyForQuery
    status, so after any statement that can change it (BEGIN/COMMIT/…, CALL, DO, or an error
    inside a block) the session probes with a savepoint: 25P01 means no block, 25P02 an aborted
    one, success an open one. The probe takes no snapshot, so `BEGIN; SET TRANSACTION …` still
    works.
  - **Manual mode** opens `BEGIN ISOLATION LEVEL …` before the first statement that needs one
    (not before VACUUM, CREATE DATABASE, `… CONCURRENTLY` and other statements that refuse a
    block). Commit and Rollback are commands, shown in Manual mode or whenever a block is open.
    Defaults per data source (store migration 3); the console can switch mode and isolation.
  - **Sessions** are keyed by data source plus optional console: a console can have its own
    session (forked with the same credentials) and its own transaction; jobs run one per
    session, so two own-session consoles run at once. Results and cursors carry the session.
  - **Schema per console**: each run puts the console's schema first in the search path
    (server-side `quote_ident`, followed by the server's default path); the registry re-applies
    it only when it differs from what it last set, so a user's own `SET search_path` stays.
  - **Nothing open is lost silently**: closing a console with its own open transaction,
    switching its session or data source, disconnecting, deleting a data source, and quitting
    (the window close is held by Rust) all ask Commit / Roll back / Cancel, with Cancel focused.
    A failed commit keeps the dialog open with the error.
  - **Cancel stage 2**: three seconds after Stop, "Drop connection" aborts the connection task,
    so a stuck statement ends at once (the server may still finish it).
  - **Read-only gap closed** (ADR-0006): statements that switch to read-write are blocked in the
    UI, and the server side restores the read-only default before every statement outside a
    block and rolls back any block made read-write (also after `set_config()` in a SELECT).
  - Tests: integration (manual commit visibility, rollback, failed blocks, explicit blocks,
    isolation, no-block statements, paging inside/after a transaction and after rollback,
    concurrent forks, schema selection and quoting, read-only switches, abort); store migration
    from version 2; classifier; UI (session/schema sent, guards for close/disconnect/quit,
    failed commit, mode switch); E2E (Manual mode to Commit).
  - Not yet: savepoint UI; refresh of results after Commit/Rollback.
- **M4.7 Editor** ✅ (plan: `docs/plans/08-editor.md`)
  - **Parameters**: `:name`, `${name}` and `$1` are found by the same scanner as statements, so
    strings, comments, quoted names, dollar-quoted bodies, `::` casts, `:=` and array slices
    are skipped, and `PREPARE` keeps its own `$n`. One prompt per name per run (with NULL), the
    values remembered per console. They are bound as text-format parameters (the server parses
    each for the type it infers), through the cursor path too (`DECLARE … CURSOR` with binds);
    placeholders keep the original length so error positions still match the console.
  - **What Run runs**: settings for a caret between statements (the nearest one, or ask) and a
    selection of several statements (all, or ask), with a chooser.
  - **Notices**: the connection task is driven by messages, so `RAISE NOTICE` and warnings reach
    the running job in order and appear under their statement in that console's Output.
  - **Output log** keeps earlier runs per console (time, data source, transaction mode, status,
    parameter values, notices), with search and Clear.
  - **Long queries**: a marker past the threshold (default 20 s) and a notification when they
    end; a notification center in the status bar.
  - **Statement timeout** setting (0 = no limit). Enforced by the session with the
    out-of-band cancel: PostgreSQL switches `statement_timeout` off before the commit that
    materializes a `WITH HOLD` cursor, so the server setting never applied to queries.
  - **Errors**: F8 / Shift+F8 go to the next and previous error marker; markers show their
    message on hover.
  - **Completion**: functions (user schemas, and built-ins without type I/O, operator, cast or
    internal ones) with signatures and overload counts; `JOIN … ON` suggestions from foreign
    keys in both directions with generated aliases; fuzzy matching (prefix, initials, word
    starts, letters in order); names resolve through the console's schema, then `public`.
  - Tests: integration (bound types, an injection attempt stays a value, notices in order,
    timeouts with and without a cursor, the function catalog); unit (parameter scanning and
    binding, run policy, fuzzy ranking, joins, search path); UI (prompt and memory, chooser,
    notices per console, output search and clear, long-query notification, F8); E2E (prompt
    scan, bound values, notice in Output).
  - Not yet: configurable parameter patterns (the three forms are built in), rows returned by
    bound statements outside a cursor (`INSERT … RETURNING` shows its row count).
- **M4.8 Result grid and table browsing** ✅ (plan: `docs/plans/07-result-grid.md`)
  - **Range selection**: mouse drag, Shift+click, row numbers, Shift+arrows, Ctrl+A. A status
    line sums the selection: count, and for numeric columns sum, average, min and max, exact for
    integers and numerics (BigInt decimals), marked "loaded rows only" when rows are not loaded.
  - **Copy** in TSV, CSV, JSON, SQL INSERT or Markdown with NULL text, header and quoting
    options, for the selection, the page or the entire result. Ctrl+C copies one cell as is and a
    range as TSV for spreadsheets. Selections gather unloaded pages two at a time (tested); the
    entire result is formatted and put on the clipboard by Rust (`result_copy`, 64 MB cap,
    confirmed above 10,000 rows). One writer per format in `quarry-io` serves copy and export.
  - **Export dialog**: the same formats and options, to a file or the clipboard, with Cancel. A
    cancelled export stops between pages and removes its `.partial` file (integration-tested).
  - **Columns**: hide, show all, reorder by drag or Move left/right, reset. Layouts are stored in
    the tab by column signature, so they survive re-runs and restarts.
  - **Edit bar**: Clone (primary key left to its default), Set DEFAULT (`SET col = DEFAULT`,
    still with the optimistic check), Revert selected; Delete marks every selected row.
  - **Result tabs**: Pin keeps a result (and its cursor) through later runs; a setting keeps
    every run's results as tabs instead (5 unpinned at most).
  - **Open data** on tables, views and materialized views: a data tab with free-form WHERE and
    ORDER BY text (with history for the session), run through the console path in the shared
    session, editable under the M4.2 rules. The text cannot end the statement or add one
    (checked), and read-only sources reject writes in it on the server (`nextval()`: 25006).
  - Round trips: CSV and TSV copies parse back with the `csv` crate, JSON with serde, and SQL
    INSERT copies run against the server and reproduce the rows exactly (awkward values:
    quotes, tabs, newlines, backslashes, Unicode, NaN, infinity, bytea, arrays, jsonb).
  - Also fixed: the run summary sat inside the result tab list (axe), and a late export progress
    message could overwrite the finished summary.
  - Not yet: value editor panel, transpose, FK navigation (Later backlog); persistent filter
    history (comes with query history, step 09).
- **M4.9 Connection gaps** ✅ (plan: `docs/plans/11-connections.md`)
  - **SSH tunnels** in pure Rust (`quarry-ssh`, russh 0.64 on ring): password, key file (with
    passphrase) and SSH agent logins; reusable SSH profiles with their own save mode. The tunnel
    is a local port forward handed to the connection as a guard, so it lives exactly as long as
    the sessions that use it (forks and side connections too) and cancel goes through it as
    well. The forward is proved at open time, so an unreachable database behind the bastion is
    reported as such. Keep-alives notice a dead SSH server within about a minute; the database
    connection then ends and the session is marked lost.
  - **Host keys**: the first connect shows the SHA-256 fingerprint and asks (Cancel focused);
    trusted keys live in `app.db`, never `~/.ssh/known_hosts`. A changed key is refused with
    both fingerprints and a warning. "Trust" only confirms the key the server just presented.
  - **TLS files**: CA file, client certificate and key (PEM), picked with the native dialog from
    Rust and read at connect time. As in libpq, a CA file makes Require verify the chain.
    Unreadable or wrong files name the file and point at the TLS tab.
  - **URL**: a `postgresql://` URL field synced with the form (IPv6, %-escapes, libpq
    parameters); a password in a URL moves to the Password field and is stripped, so URLs never
    keep one. "URL only" shows just the URL.
  - **Options**: TCP keep-alive, auto-disconnect after idle minutes (never while a statement,
    export or transaction is open), startup SQL after every connect.
  - **Explorer**: one level of folders (color inherited by data sources without their own),
    drag to reorder or into a folder, Move up/down and Move to folder for the keyboard, inline
    rename (Shift+F6 or F2) for data sources and folders.
  - **Schema scope**: checked schemas plus wildcard patterns; the schema list, completion
    relations and user functions are filtered in SQL. An edit applies to the live session at
    once. Connected sources with a scope show "N of M schemas".
  - **Failure view**: the error with a checklist (SSH tunnel, reachable, TLS, credentials) that
    marks the failing step, plus Test Connection, Edit and Connect. One connect flow asks for the
    database password, the SSH password or passphrase (again after a wrong one) and host key
    trust.
  - Tests: integration against the disposable server and SSH container (queries, cancel, export
    and forks over a tunnel; password, passphrase and agent logins; unknown and changed host
    keys; unreachable forward; killed SSH session marks the session lost; verify-full with the
    test CA, client certificate login, wrong CA also with Require, unreadable files; schema
    scope in schemas, relations and functions); canary (SSH secrets in every save mode never in
    the log, `app.db` or IPC responses); unit (URL round trips, store migration, folders and
    order, SSH secret accounts, trust only of presented keys, idle decision); UI (tabs, URL,
    SSH test before save, schema selection, prompts, checklist, folders, drag, rename, scope
    label and reload); E2E (axe on every dialog tab and the folder tree, drag into a folder).
  - Not yet: Windows agent (OpenSSH pipe, then Pageant) is built but untested; jump hosts;
    encrypted client keys for TLS; nested folders.
- **M4.10 Layout, navigation and explorer** ✅ (plan: `docs/plans/12-layout-navigation.md`)
  - **Search everywhere** (Ctrl+Shift+A; Go to object Ctrl+N, Cmd+O on macOS): tables, views,
    routines and sequences of every connected data source, console files and actions, ranked
    exact, prefix, word start, substring, then fuzzy; `schema.name` matches both parts;
    `/tables`, `/views`, `/routines`, `/sequences`, `/objects`, `/consoles`, `/actions` narrow
    (Tab completes). Enter opens (table viewer, or DDL for routines and sequences),
    Ctrl+Enter opens data, Shift+Enter shows DDL, Alt+Enter reveals in the explorer.
  - **Go to DDL** (Ctrl+B) from the editor resolves the name at the caret through the
    statement's aliases and table names, then the catalog (console schema, `public`, unique
    match); a bare column goes to the statement's table that has it. Ctrl+B in the explorer shows
    DDL of the selection. Alt+F1 reveals the object at the caret in the explorer, connecting and
    expanding the way.
  - **Tabs**: context menu (Close, Close others, Close to the right, Close all, Pin, Reopen
    closed, Rename, Duplicate, Copy path, Delete for consoles, Reveal for viewers), pinned tabs
    first and kept, an All tabs list, path tooltips, arrow keys between tabs. Reopen closed
    (Ctrl+Shift+T) keeps 20 tabs and reads console text from the file again.
  - **Consoles**: rename (never replaces another console; same tab, editor and undo history),
    duplicate, delete (asks first; only regular files inside the consoles directory, links
    refused). A console without a data source asks which one to attach when run.
  - **Navigation**: Back/Forward across tabs with caret positions (Ctrl+Alt+Left/Right, Cmd+[
    and Cmd+]), Recent tabs (Ctrl+E) with recently closed consoles; Escape in the explorer or
    results panel returns to the editor; Hide all panels (Ctrl+Shift+F12) toggles both.
  - **Status bar**: current schema and encoding (UTF-8) of the active console.
  - **Explorer**: Shift/Ctrl+click and Shift+arrows mark several objects for Show DDL, Copy
    DDL or Copy names; object type filter; Collapse all, Expand loaded levels; Force refresh
    with the last refresh time in the tooltip; Cancel on loading rows (server cancel only when
    no statement runs on the shared session); Enter/F3 and Shift+Enter/Shift+F3 in the filter
    jump between matches.
  - Also: app shortcuts are suspended while a modal dialog has focus.
  - Tests: unit (ranking, prefixes, 1,000 tables in well under 100 ms; console rename, duplicate
    and delete incl. a symlink); integration (`catalog` level); UI (reopen closed restores text,
    rename keeps editor and binding, delete asks, pinned tabs, tab keys and list, back/forward
    and recent, attach, Escape and hide panels, status bar, palette open/data/DDL/consoles/
    actions/reveal, Go to DDL through aliases, explorer filter, collapse/expand, multi-select,
    match navigation, cancel, force refresh); E2E (palette with axe in both browsers).
  - Not yet: undocking panels, editor split, bookmarks (Later backlog).
- Table viewer (columns/indexes/constraints/FKs), DDL generation, create/alter forms with DDL preview,
  destructive-operation confirmation.

### Phase 5 — Developer productivity

- Query history with FTS search; saved consoles/files; snippets; configurable keymap; workspace
  restore; CSV/JSON import with preview, mapping, type validation, null/encoding handling, and
  streaming.
- **M5.3 Keymap and action registry** ✅ (plan: `docs/plans/10-keymap-actions.md`)
  - **Registry**: every action is registered once with a title, a context (everywhere, SQL
    editor, result grid, Database Explorer) and default bindings per platform; the 13 earlier
    command ids are unchanged. The grid's and explorer's command keys (select all, copy, edit,
    delete, add row, column menu, quick info, refresh, duplicate, context menu) moved into it.
  - **Resolution**: the focused panel's actions win over global ones; one capture-phase listener
    runs global and editor actions before Monaco sees the key.
  - **Settings > Keymap**: search by action or shortcut, add a shortcut by pressing it, remove,
    reset one or all; conflicts show inline before saving and same-context clashes block Save;
    reserved system chords and plain typing keys are refused. Overrides live in settings.
  - **macOS**: Cmd is the primary modifier and Control is separate; ⌘⌥⇧⌃ labels; defaults
    avoid system chords (⌘Q, ⌘Tab, Option-arrows).
  - Docs: `docs/keymap.md`, generated from the registry and checked by a test.
  - Tests: unit (chords per platform, focused context over global, overrides, conflicts,
    reserved chords, defaults conflict-free on both platforms); UI (rebind works at once and
    after a restart, the old chord stops working, conflicts and blocked Save, refusals, reset,
    search, editor actions only with editor focus); E2E (rebind and use in both browsers, axe).
  - Not yet: importing keymaps from other IDEs (out of scope); the search palette (step 12).
- **M5.4 CSV/JSON import** ✅ (plan: `docs/plans/13-import.md`)
  - **Wizard** from a schema (new table) or table (append) in the explorer, or by dropping a file
    on one: File (format, encoding, delimiter, quote, escape, header, trim, NULL text, empty as
    NULL, presets, live preview with inferred types and the row estimate), Target, Columns
    (include, target column, type with suggestions, order), Review (CREATE TABLE built by the
    schema tools, editable; error policy), Import (progress, rows/s, Cancel, summary with
    rejected rows by line, Save Error Log).
  - **Reading** in `quarry-io`: own streaming delimited parser (quoted `""` vs empty NULL,
    doubled or escaped quotes, newlines in quotes, CR/LF, line numbers), BOM and encoding
    detection with streaming transcoding, JSON arrays element by element and JSON lines.
  - **Types**: inference over 1,000 sample rows (boolean, integer, bigint, numeric, date,
    timestamp, timestamptz, uuid, jsonb, text); per-row checks against the target column type
    (ranges, numeric precision, lengths, calendar dates, JSON) so Skip and NULL work and Abort
    names the line.
  - **Loading**: one COPY in one transaction on a side connection after the setup statements;
    any failure or Cancel rolls back the table and the rows. Read-only sources refuse;
    production sources confirm with the target and row estimate.
  - **File access**: only paths picked in the native dialog or dropped on the window (received
    by Rust); the WebView gets an id and a 200-row preview at most.
  - Tests: unit (parser: quoting, NULL token vs empty, BOM, Latin-1, UTF-16, buffer boundaries,
    unclosed quotes; JSON; inference; conversions; COPY encoding; mapping); integration (abort
    leaves nothing, skip lists lines, NULL policy, new table plus load atomic, JSON by key,
    read-only refused, 1M rows with about 1 MB peak memory growth, cancel leaves none); UI
    (whole flow, presets, production confirmation, cancel, read-only refusal, drop target); E2E
    (wizard with axe at every step).
  - Not yet: Excel, Parquet, pg_dump, disabling triggers during load (REQ-IMPEX-09 to 11).
- **M5.2 Local file history** ✅ (plan: `docs/plans/14-file-history.md`)
  - **Revisions** of console files in `app.db` (migration 6), taken sparingly: while editing at
    most once per interval, always before a save that deletes most of the text, when the file
    was changed outside Quarry, and before a run, a format, a restore or a delete. Repeats and
    blank text are skipped; renames carry the history along.
  - **Local history** (Alt+Shift+H, or the tab menu): versions with time, reason and first line,
    a line diff against the current text, and Restore, which first keeps the replaced text.
  - **Retention** in Settings: versions per console, maximum age, interval.
  - Tests: unit (autosave bursts make one revision, deletion and outside changes always kept,
    pruning by count and age, rename, upgrade from version 5, line diff); desktop (the save
    path keeps deleted text and outside edits); UI (diff and restore, before-run and
    before-format checkpoints, settings); E2E (axe on the dialog).
- **M5.1 Query history** ✅ (plan: `docs/plans/09-query-history.md`)
  - **Recording**: the query job in Rust records every statement that reached the server
    (succeeded, failed or cancelled) with data source, console session, start time, duration,
    rows, error summary and transaction mode, in one batch per run after it finishes, so a
    closed window loses nothing. A statement skipped after a cancel is not recorded.
  - **Storage**: `query_history` in `app.db` (migration 4) with an FTS5 index kept in sync by
    triggers; entries go with their data source when it is deleted. Search turns each word into
    a quoted prefix phrase, so input is never parsed as FTS syntax; 10,000 entries search in
    well under 100 ms (tested).
  - **Retention**: 10,000 entries per data source by default, plus an optional age limit, both
    in Settings; pruning runs after each recorded batch and when the settings change.
  - **Per data source**: "Record query history" in the connection dialog (on by default), with
    help text saying statements are kept as typed, values included.
  - **Popup** (Ctrl+Alt+E or the toolbar): search, data source filter, status icons, duration
    and time, paging; Insert at the caret or Open in new console; Delete and Clear data source
    history, both confirmed; CSV or JSON export through the native save dialog.
  - Tests: store (migration from version 3, FTS5 present, retention by count and age, search by
    table name and keyword, index in sync after delete and clear, disabled data sources write
    nothing, 10,000-entry timing); integration (success, error and cancel recorded with their
    status, nothing for a disabled data source); UI (search, insert, open, confirmations,
    export, settings); E2E (run, find, reopen, axe).
  - Not yet: redacting literals and the internal execution log (Later, ADR-0004).

### Phase 6 — AI assistant

- Provider abstraction plus Anthropic; per-connection context levels; "what will be sent" preview;
  generate/explain/fix/optimise; output only to preview/insert.

### Phase 7 — Hardening and release

- Fault injection (network drop mid-query, permission denied, server restart).
- Large-result soak tests.
- Credential and execution-safety audit.
- Installers (AppImage/deb, MSI, dmg) with signing.
- Docs: setup, supported databases, limitations, release procedure.

## Global acceptance rules

- No fake or decorative controls: a button that is not implemented is not rendered.
- No hardcoded results in production paths. Mocks live only in tests.
- A database is listed as supported only after its adapter contract suite passes.
- Every destructive or production-write path has an automated test proving the confirmation is
  required.
