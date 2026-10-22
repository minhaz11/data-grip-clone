# Architecture Overview

Working name: **Quarry**. This is a placeholder; rename it before the first public build. It is
deliberately unrelated to JetBrains branding.

## Process model

```
┌──────────────────────── WebView (React + TS) ─────────────────────────┐
│ UI only. Holds no DB connections, secrets, or file handles.            │
│ shell · explorer · editor (Monaco) · grid · dialogs · settings · ai    │
│                ▲ typed invoke()/events (generated TS bindings)         │
└────────────────┼───────────────────────────────────────────────────────┘
                 │ Tauri IPC, restricted by capabilities/default.json
┌────────────────┼──────────── Rust backend (tokio) ────────────────────┐
│ app (commands, state, event bus, redacting logger)                     │
│  ├─ conn-manager ── secrets (keyring)                                  │
│  ├─ session-pool ── db-core ◄─ db-postgres | db-mysql | db-sqlite      │
│  ├─ exec (job registry, cancel, timeouts, paging buffers)              │
│  ├─ metadata (lazy introspection cache, per connection)                │
│  ├─ sql (dialect, splitter, classifier, DDL generation)                │
│  ├─ store (app.db: settings, history, snippets, workspace, consents)   │
│  ├─ io (CSV/JSON import/export, streaming)                             │
│  └─ ai-core ◄─ ai-anthropic                                            │
└────────────────────────────────────────────────────────────────────────┘
```

## Repository layout

```
apps/desktop/                  Tauri app
  src/                         React frontend
    app/                       shell, layout, routing of panels, theme
    features/<module>/         one folder per product module (below)
    components/ui/             reusable accessible primitives
    ipc/                       generated bindings (bindings.ts), typed client, in-memory backend
    lib/sql/                   statement splitter, classifier, completion context (ADR-0006)
  src-tauri/                   Tauri entry crate: commands, job registry, sessions, bindings test
crates/
  db-core  db-postgres  connections  secrets  store  workspace  io      built
  ai-core  ai-anthropic                                                 planned (steps 16 to 18)
docs/  (reverse-engineering, architecture, decisions, plans)
tests/e2e/                     planned: Playwright with the in-memory backend (step 02)
```

The diagram above shows logical components. The `exec`, `metadata` and `sql` boxes did not become
separate crates: the engine-neutral contract lives in `db-core`, the PostgreSQL implementations in
`db-postgres` (`exec.rs`, `metadata.rs`, `refine.rs`, `edits.rs`), the job registry in
`src-tauri/src/exec.rs`, and the splitter and classifier in TypeScript (ADR-0006).

The Rust backend is a Cargo workspace. The frontend uses npm workspaces (single app for now). Each
domain crate is unit-testable without Tauri.

## Product modules and boundaries

| Module                | Frontend (`features/`) | Backend crate(s)                  | Owns                                                        | Must not                                         |
| --------------------- | ---------------------- | --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| A. Connection Manager | `connections`          | `app::conn`, `secrets`, `store`   | profiles, environments, test, lifecycle                     | expose secrets to UI                             |
| B. Database Explorer  | `explorer`             | `metadata`, `db-*`                | lazy tree, search, refresh, DDL view                        | run user SQL                                     |
| C. SQL Editor         | `editor`               | `sql`, `exec`                     | tabs/consoles, split/current statement, run/cancel, errors  | render results                                   |
| D. Result Grid        | `grid`                 | `exec` (paging), `sql` (edit DML) | virtualized view, sort/filter, pending edits, submit/revert | issue SQL directly (requests edits via commands) |
| E. Schema Tools       | `schema`               | `sql` (DDL gen), `db-*`           | table viewer, create/alter forms, DDL preview               | apply DDL without preview + confirm              |
| F. Workspace          | `workspace`            | `store`                           | history (FTS), snippets, saved files, restore               | —                                                |
| G. AI Assistant       | `ai`                   | `ai-core`, `ai-anthropic`         | context builder, consent, streaming, preview                | execute SQL                                      |
| H. Import/Export      | `io`                   | `io`                              | streaming CSV/JSON, mapping preview, validation             | load whole files in memory                       |
| I. Settings           | `settings`             | `store`, `secrets`                | prefs, keymap, themes, diagnostics (redacted)               | —                                                |

Cross-cutting pieces:

- **Event bus**: a backend → frontend channel for `exec:*`, `metadata:*`, and `conn:*` events.
- **Job registry**: every long operation has a `job_id` and can be cancelled.
- **Statement classifier**: read / write / ddl / tx-control / unknown. Used by read-only enforcement,
  destructive confirmation, production guard, and AI consent.

## IPC contract principles

1. Commands are **coarse-grained and typed**. Every type that crosses IPC is generated from Rust
   with `ts-rs` into `apps/desktop/src/ipc/bindings.ts` (`npm run bindings`); `cargo test` fails
   when the file is stale. A second test checks that the command names in `build.rs`,
   `capabilities/default.json`, `generate_handler!` and `ipc/client.ts` agree. The `invoke`
   wrappers in `client.ts` stay hand-written.
2. Long work returns a `job_id` immediately. Progress, pages, and completion arrive as events. The UI
   never awaits a query on the invoke promise.
3. Errors are a single serializable `AppError { kind, message, hint?, sqlstate?, connectKind? }`
   and contain no secrets. Statement failures inside a job arrive as `StatementError` events
   (with `detail` and `position`), not as rejected calls.
4. Large payloads are paged (`exec_fetch_page(job_id, offset, limit)`). Files stream in Rust; the UI
   gets progress only.
5. The capability file allows only our commands plus a minimal set of core plugins
   (dialog/open-save, clipboard). There is no shell, no fs scope beyond user-picked files, and no
   http plugin, because the AI goes through Rust.

## Safety model for execution

`execute(job)` runs these steps in order:

1. Classify every statement.
2. If the connection is **read-only** and any statement is a write or DDL, block it with an
   explanation.
3. If a statement is **destructive** (DROP/TRUNCATE/ALTER … DROP, or DELETE/UPDATE without WHERE),
   show a confirmation dialog that lists the statements.
4. If the connection environment is **production**, require an extra confirmation for any write,
   showing the connection name in its environment colour.
5. Run with a timeout and cancel handle.
6. Record history.

AI-originated SQL goes through exactly the same path.

## Frontend stack choices

- React 18+, TypeScript strict, Vite, Tailwind with CSS-variable design tokens (light/dark),
  Radix-style accessible primitives.
- Monaco Editor with a custom completion provider fed by the metadata cache, and dialect keyword
  lists.
- Resizable panels via `react-resizable-panels`.
- Grid: virtualized; final library chosen by a WebKitGTK benchmark in Phase 3. Candidates:
  - TanStack Table + Virtual (DOM, accessible).
  - Glide Data Grid (canvas, fastest).
- State: Zustand stores per feature. Server-ish state (metadata, history) via TanStack Query over IPC.

## Testing strategy

| Layer            | Tooling                                                                                                        | Scope                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Rust unit        | `cargo test`                                                                                                   | splitter, classifier, quoting, DDL gen, redaction, migrations |
| Rust integration | `cargo test --features it` + disposable Postgres in Docker (`quarry-test-pg`, port **55432**, throwaway creds) | adapter contract suite                                        |
| Frontend unit    | Vitest + Testing Library                                                                                       | components, stores, keymap                                    |
| UI E2E           | Playwright against Vite build with mocked IPC                                                                  | layout, flows, a11y (axe)                                     |
| Desktop E2E      | `tauri-driver` + WebdriverIO (Linux CI)                                                                        | real backend smoke                                            |

Integration tests must **never** target the developer's existing containers (currently on ports 5433
and 5435). The harness starts and stops its own uniquely named container.
