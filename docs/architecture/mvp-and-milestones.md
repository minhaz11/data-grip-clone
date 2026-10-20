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
  - Not yet: custom CA / client certificates (REQ-CONN-08), SSH tunnels (REQ-CONN-07).
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
  - Not yet: keys/foreign keys, routines, sequences, DDL view (Phase 4), tree virtualization (not
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
  - Not yet: NOTICE messages, per-console sessions, transaction mode controls (REQ-TX-01),
    query history (Phase 5), statement timeouts as a setting.
- **M3.3 Grid + export**: virtualized paged grid; multiple result tabs; CSV/JSON export streamed from
  the backend.
  - **AC**: a 1M-row result never sends more than 2 pages over IPC at once; it scrolls smoothly in
    WebKitGTK; the exported file matches row count and content.

### Phase 4 — Data and schema management

- Server-side sort/filter (WHERE/ORDER BY builders with bound values), paging controls.
- Safe row editing:
  - Requires a PK/unique key (otherwise read-only, with a reason shown).
  - Pending-change highlighting.
  - Preview of the generated DML.
  - Submit in a transaction, and revert.
- Table viewer (columns/indexes/constraints/FKs), DDL generation, create/alter forms with DDL preview,
  destructive-operation confirmation.

### Phase 5 — Developer productivity

- Query history with FTS search; saved consoles/files; snippets; configurable keymap; workspace
  restore; CSV/JSON import with preview, mapping, type validation, null/encoding handling, and
  streaming.

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
