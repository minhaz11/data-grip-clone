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

**Interim deviation (remove in M3.1):** until consoles are file-backed, open console text is kept in
the `workspace_state` JSON (capped at 8 MB) so it survives restarts. ADR-0004's "consoles are `.sql`
files" applies from M3.1.

### Phase 2 — PostgreSQL connectivity

- **M2.1 Connection profiles** ✅: CRUD, duplicate (copies the password, per [DOC] 02), environment
  tag + colour, read-only flag, keyring secrets with save modes Forever / Until restart / Never.
  - **AC**: no secret appears in `app.db`, logs, or any IPC response (test asserts this).
  - Done: `quarry-secrets` (keyring + memory stores, `SecretString` is not `Serialize`),
    `quarry-store` migration 2, `quarry-connections` (rollback on keyring failure, secret moves on
    save-mode change, delete aborts if the keyring refuses). A canary test scans `app.db`/WAL bytes,
    serialized profiles and `Debug` output. There is no logging framework yet; the redacting logger
    arrives with the first log statement.
- **M2.2 Test connection + lifecycle**: test with timeout; categorized actionable errors (DNS,
  refused, auth, TLS, timeout, database missing); connect/disconnect; SSL modes.
  - **AC**: each error category is reproduced against the disposable container (or a closed port) and
    shown with a hint.
- **M2.3 Metadata tree**: lazy schema → kind → object → children; refresh; filter.
  - **AC**: 1,000-table schema expands in < 1 s after the first load; refresh picks up a new table.

### Phase 3 — SQL execution

- **M3.1 Editor**: Monaco tabs/consoles backed by files; PostgreSQL highlighting; format; completion
  for keywords, schemas, tables, and columns.
- **M3.2 Execution**: Rust splitter (dollar quotes, comments, strings); current/selection/script;
  job events; timing; cancel; error position → editor marker.
  - **AC**: `SELECT pg_sleep(30)` cancels within 1 s, and the UI stays responsive throughout.
  - **AC**: a syntax error underlines the right token.
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
