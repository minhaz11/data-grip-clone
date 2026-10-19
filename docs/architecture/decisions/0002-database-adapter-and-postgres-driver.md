# ADR-0002 — Database adapter interface; PostgreSQL via tokio-postgres

- Status: **Accepted** (2026-10-19)

## Context

The UI must be engine-agnostic. Adding MySQL, SQLite, and later SQL Server must not require UI or
architecture rewrites. DataGrip layers per-dialect modules on a generic/SQL-92 base
(00-methodology, E2). An IDE executes **arbitrary user SQL**, so drivers must return dynamically typed
result sets, multiple results per script, notices, precise errors, and support cancellation.

## Decision

### Backend crate layout

- `crates/db-core`: engine-neutral types and the `DatabaseAdapter` / `Session` traits. Contains no driver code.
- `crates/db-postgres`: implements the traits with `tokio-postgres` + `tokio-postgres-rustls`
  (TLS via rustls, no system OpenSSL).
- Later: `db-mysql` (`mysql_async`) and `db-sqlite` (`rusqlite`, run on a blocking thread pool).
  Engines without a good Rust driver may use an out-of-process sidecar that implements the same trait
  over JSON-RPC.

### Trait shape (illustrative; finalized in Phase 2)

```rust
#[async_trait]
pub trait DatabaseAdapter: Send + Sync {
    fn engine(&self) -> Engine;                       // Postgres, MySql, Sqlite...
    fn dialect(&self) -> &'static dyn Dialect;        // quoting, splitting rules, DDL generation
    async fn test(&self, cfg: &ConnectionConfig, secret: &Secret) -> Result<ServerInfo, DbError>;
    async fn open(&self, cfg: &ConnectionConfig, secret: &Secret) -> Result<Box<dyn Session>, DbError>;
}

#[async_trait]
pub trait Session: Send {
    async fn execute(&mut self, sql: &str, opts: ExecOptions, sink: &dyn ResultSink) -> Result<ExecSummary, DbError>;
    fn cancel_handle(&self) -> Box<dyn CancelHandle>;           // usable from another task
    async fn metadata(&mut self, req: MetadataRequest) -> Result<MetadataNode, DbError>; // lazy, per level
    async fn ddl(&mut self, obj: &ObjectRef) -> Result<String, DbError>;
    async fn set_transaction_mode(&mut self, mode: TxMode) -> Result<(), DbError>;
    async fn commit(&mut self) -> Result<(), DbError>;
    async fn rollback(&mut self) -> Result<(), DbError>;
}
```

### Results and types

- Results stream into a `ResultSink` in **pages** (default 500 rows, configurable).
- The backend keeps the cursor or buffer. The UI requests more pages, so whole result sets never
  cross IPC.
- Values cross IPC as a tagged `CellValue` enum: `Null | Bool | Int(i64) | Decimal(String) | Float(f64) |
Text | Bytes(base64, truncated) | Json | Timestamp(String) | Array | Unknown(String)`.
  - Precision-sensitive types (`numeric`, `int8` beyond 2^53, timestamps) cross as **strings**, so
    JavaScript never loses precision.

### PostgreSQL specifics

- **User SQL** runs as `simple_query` for multi-statement scripts when no parameters are used.
  Otherwise we split statements with a dialect-aware splitter that handles `$$`/`$tag$` dollar quoting,
  `E''` strings, nested block comments, and `;` inside quotes, then run each statement through the
  extended protocol to get typed columns.
- **Errors** map `DbError` to `{ sqlstate, message, detail, hint, position → (line, col) }`, resolved
  against the original editor text.
- **Cancellation** uses `client.cancel_token().cancel_query(tls)` from a separate task. Each
  execution has a client-side timeout plus an optional server-side `statement_timeout`.
- **Metadata** queries `pg_catalog` with **app-authored, parameterized** SQL, never string-interpolated
  identifiers. Lazy levels: databases → schemas → object kinds → objects → columns/indexes/constraints.
- **Read-only connections** set `default_transaction_read_only = on` at session start. They are also
  enforced in the app layer: statements classified as writes are rejected before they are sent
  (defence in depth; the server setting is authoritative).

### Identifier safety

Application-generated SQL (DDL generation, grid edits, import) quotes identifiers with the dialect's
`quote_ident` and sends **values as bind parameters**. String concatenation of values is forbidden and
lint-checked by code review.

## Consequences

- A new engine is one crate implementing the traits, plus a `Dialect` (quoting, splitter, DDL).
  The UI needs no changes beyond engine-specific connection-form fields, which are declared by the
  adapter as a schema.
- An engine is listed as **supported** only after its contract test suite passes:
  connect/test, metadata, execute, cancel, errors, and editing.
