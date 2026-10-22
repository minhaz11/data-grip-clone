# ADR-0006: SQL splitter and statement classifier live in TypeScript

- Status: **Accepted** (2026-10-22)

## Context

REQ-EDIT-03 asked for statement detection "in Rust", and the architecture overview listed a Rust
`sql` crate for the dialect, splitter and classifier. What was built in M3.1 and M3.2 is different:

- `apps/desktop/src/lib/sql/statements.ts` splits a console into statements (quotes, E-strings,
  dollar quotes, nested comments) and picks the selection, current statement or script.
- `apps/desktop/src/lib/sql/classify.ts` classifies each statement (read, write, ddl, session,
  unknown; destructive reasons), and `features/exec/runQuery.tsx` applies the guards: read-only
  sources block writes, destructive statements and production writes need confirmation.
- `lib/sql/completionContext.ts` reuses the same lexer for completion.
- The backend receives already split statements (`ExecRequest.statements`) and does not classify
  them.

## Decision

Keep the splitter and classifier in TypeScript.

- The editor needs them synchronously on every keystroke and caret move (current statement
  highlight, completion context, run target). An IPC round trip per keystroke would add latency
  for no safety gain.
- One implementation serves the editor, the guards and completion, so they cannot disagree about
  where a statement starts or what it does.
- AI-generated SQL (steps 16 to 18) is inserted into the editor and run with the normal Execute
  action, so it passes through the same guards (ADR-0005).

REQ-EDIT-03's "in Rust" is **deferred**, not dropped: if a caller that does not go through the
editor ever executes SQL (an AI agent loop, a CLI, scheduled jobs), the classifier must move to
Rust (or be shared, e.g. compiled to WASM) and run in the backend before execution.

## Consequences

- The confirmations (destructive statements, production writes) are a **UX safety net in the
  UI**, not a security boundary. A user who owns the credentials can always reach the database
  with another client.
- Read-only sources are also enforced by the server (`default_transaction_read_only = on` at
  connect). That setting can be changed by the session itself. Today this statement is classified
  as `session` and allowed:
  `SET default_transaction_read_only = off`. After it, a `SELECT` that calls a writing function
  would succeed. Closing this gap is the first task
  of step 03 (block those settings on read-only sources, or run read-only work inside an explicit
  `READ ONLY` transaction). For a hard guarantee, users should connect with a database role that
  has no write privileges; the connection dialog should say so.
- Rust-side tests cannot cover the guards; they are covered by the TS unit tests
  (`lib/sql/*.test.ts`) and the UI tests in `features/exec/`.
