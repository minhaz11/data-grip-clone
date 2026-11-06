//! Engine-neutral adapter contract (ADR-0002). The UI and app layer only see these types; each
//! engine crate (`quarry-db-postgres`, later MySQL/SQLite) implements [`DatabaseAdapter`].

mod ddl;
mod details;
mod exec;
mod metadata;
mod schema;
mod scope;
mod tx;

use std::any::Any;
use std::fmt;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use quarry_secrets::SecretString;
use serde::Serialize;

pub use ddl::{DdlObject, DdlOptions};
pub use details::{
    ColumnDetail, ConstraintDetail, ForeignKeyDetail, IndexDetail, ObjectDetails, ObjectRef,
    TriggerDetail,
};
pub use exec::{
    Cell, ColumnInfo, ColumnValue, EditColumn, EditStatement, EditTarget, Editability,
    ErrorPosition, ExecOptions, Filter, FilterOp, Notice, NoticeSink, Refinement, RowChange,
    SortKey, StatementOutcome,
};
pub use metadata::{MetaKind, MetaNode, MetadataRequest, ObjectType};
pub use schema::{
    CheckModel, ColumnModel, DropObject, FkAction, ForeignKeyModel, Identity, IndexModel, KeyModel,
    RenameObject, SchemaChange, TableModel, TableName,
};
pub use scope::SchemaScope;
pub use tx::{Isolation, TxMode, TxSettings, TxStatus};

/// TLS policy, with libpq semantics: `Prefer`/`Require` encrypt without verifying the certificate;
/// `VerifyCa` checks the chain; `VerifyFull` also checks the host name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsMode {
    Disable,
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

/// Everything needed to open a connection. `Debug` never prints the password.
#[derive(Clone)]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub password: Option<SecretString>,
    pub tls: TlsMode,
    pub connect_timeout: Duration,
    /// Ask the server to reject writes for this session (defence in depth; ADR-0002).
    pub read_only: bool,
    pub application_name: String,
    pub options: ConnectOptions,
}

/// PEM files for TLS, read at connect time (their contents are never stored).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TlsFiles {
    /// Trusted roots instead of the system store (libpq `sslrootcert`). With a CA file, `Require`
    /// verifies the chain like `VerifyCa`, as libpq does.
    pub ca: Option<PathBuf>,
    /// Client certificate chain and its private key (libpq `sslcert`/`sslkey`), both or neither.
    pub cert: Option<PathBuf>,
    pub key: Option<PathBuf>,
}

/// Connection options beyond the endpoint and credentials.
#[derive(Clone, Default)]
pub struct ConnectOptions {
    /// Connect here instead of resolving `host` (the local end of an SSH tunnel). `host` stays
    /// the TLS server name, so certificate checks still name the real server.
    pub dial: Option<SocketAddr>,
    /// Held by every session opened with these parameters (forks and side connections too), so
    /// whatever it owns, such as a tunnel, lives exactly as long as they do.
    pub guard: Option<Arc<dyn Any + Send + Sync>>,
    pub tls_files: TlsFiles,
    /// TCP keep-alive idle time; `None` keeps the system default.
    pub keepalive: Option<Duration>,
    /// Statements run after every connect (session settings such as `SET search_path`).
    pub startup_sql: String,
    /// Schemas the explorer and completion introspect.
    pub schema_scope: SchemaScope,
}

impl fmt::Debug for ConnectOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectOptions")
            .field("dial", &self.dial)
            .field("guard", &self.guard.as_ref().map(|_| "…"))
            .field("tls_files", &self.tls_files)
            .field("keepalive", &self.keepalive)
            .field("startup_sql_len", &self.startup_sql.len())
            .field("schema_scope", &self.schema_scope)
            .finish()
    }
}

impl fmt::Debug for ConnectParams {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectParams")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("database", &self.database)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "***"))
            .field("tls", &self.tls)
            .field("connect_timeout", &self.connect_timeout)
            .field("read_only", &self.read_only)
            .field("options", &self.options)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// Full version banner, e.g. "PostgreSQL 16.15 on x86_64-pc-linux-musl ...".
    pub version: String,
    /// Short version, e.g. "16.15".
    pub server_version: String,
    pub database: String,
    pub user: String,
    pub tls: bool,
    pub read_only: bool,
    /// Wall time to resolve, connect, authenticate and run the probe query.
    pub latency_ms: u64,
}

/// Why a connection attempt failed, in terms a user can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum ConnectErrorKind {
    /// The host name could not be resolved.
    Dns,
    /// Nothing accepted the TCP connection.
    Refused,
    /// No answer within the connect timeout.
    Timeout,
    /// The server rejected the user name or password.
    Auth,
    /// Authentication failed and no password was supplied: the UI should ask for one.
    PasswordRequired,
    /// The database does not exist.
    DatabaseMissing,
    /// TLS was required but failed (unsupported, untrusted certificate, name mismatch, ...).
    Tls,
    /// The server is starting, shutting down, or at its connection limit.
    ServerUnavailable,
    /// The SSH server's host key is not known yet: the user must check and trust it.
    SshHostUnknown,
    /// The SSH server presented a different host key than the trusted one (possible attack).
    SshHostChanged,
    /// The SSH password or key passphrase is not stored: the UI should ask for it.
    SshSecretRequired,
    /// The SSH tunnel could not be opened (unreachable SSH server, forwarding refused, bad key).
    Ssh,
    /// Anything else (protocol errors, unexpected server responses).
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectError {
    pub kind: ConnectErrorKind,
    /// What happened, including the server's/driver's own words where useful.
    pub message: String,
    /// What the user can do about it.
    pub hint: String,
    pub sqlstate: Option<String>,
}

impl fmt::Display for ConnectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.message, self.hint)
    }
}

impl std::error::Error for ConnectError {}

/// Called once when a live session ends; `Some(reason)` if it ended unexpectedly.
pub type OnClose = Box<dyn FnOnce(Option<String>) + Send>;

#[async_trait::async_trait]
pub trait DatabaseAdapter: Send + Sync {
    /// Connects, authenticates, runs a probe query and disconnects.
    async fn test(&self, params: &ConnectParams) -> Result<ServerInfo, ConnectError>;
    /// Opens a session that stays open until [`Session::close`] or the server drops it.
    async fn connect(
        &self,
        params: &ConnectParams,
        on_close: OnClose,
    ) -> Result<Arc<dyn Session>, ConnectError>;
    /// The statements a schema change would run, exactly (no connection needed).
    fn preview_schema(&self, change: &SchemaChange) -> Result<Vec<String>, DbError>;
}

/// A failure while using an open session (as opposed to [`ConnectError`] while opening one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DbError {
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    pub sqlstate: Option<String>,
    /// 1-based character offset into the statement where the server located the problem.
    pub position: Option<ErrorPosition>,
    /// The session is gone (server closed it, network dropped); reconnecting is the remedy.
    pub connection_lost: bool,
    /// The statement was cancelled (by the user or a timeout).
    pub cancelled: bool,
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DbError {}

/// Rows being loaded into a table with COPY, in one transaction on a separate connection, so the
/// load is all or nothing and never mixes with a console's transaction.
#[async_trait::async_trait]
pub trait ImportSink: Send {
    /// Writes rows in PostgreSQL COPY text format (tab-separated, `\N` for NULL, backslash
    /// escapes, one row per line).
    async fn write(&mut self, rows: Vec<u8>) -> Result<(), DbError>;
    /// Ends the COPY and commits; returns how many rows were loaded.
    async fn finish(self: Box<Self>) -> Result<u64, DbError>;
    /// Rolls everything back, the setup statements included.
    async fn abort(self: Box<Self>);
}

/// An open connection. Shared (`Arc`) so metadata and, later, query execution can run without
/// holding the session registry lock.
#[async_trait::async_trait]
pub trait Session: Send + Sync {
    fn info(&self) -> &ServerInfo;
    fn is_closed(&self) -> bool;
    /// Children of one tree level. Every query is app-authored and parameterized.
    async fn metadata(&self, request: &MetadataRequest) -> Result<Vec<MetaNode>, DbError>;
    /// Columns, indexes, constraints, foreign keys (both directions), triggers and size of one
    /// object; `None` if it no longer exists.
    async fn object_details(&self, object: &ObjectRef) -> Result<Option<ObjectDetails>, DbError>;
    /// DDL for `objects` from the catalog, as one script that applies cleanly in order. Runs on
    /// a separate short-lived connection, so this session's transaction is never touched.
    async fn ddl(&self, objects: &[DdlObject], options: &DdlOptions) -> Result<String, DbError>;
    /// The editable model of a table (Modify Table); `None` if it no longer exists.
    async fn table_model(&self, schema: &str, name: &str) -> Result<Option<TableModel>, DbError>;
    /// Runs `statements` in one transaction on a separate short-lived connection; the first
    /// failure rolls everything back and names the statement.
    async fn apply_schema(&self, statements: &[String]) -> Result<(), DbError>;
    /// Runs one statement exactly as given (no parameters, no rewriting).
    async fn execute(&self, sql: &str, options: &ExecOptions) -> Result<StatementOutcome, DbError>;
    /// Runs one statement with `$1…$n` bound to `params` (text values the server converts to
    /// the types it infers; `None` is NULL). Values never become part of the SQL text.
    async fn execute_params(
        &self,
        sql: &str,
        params: &[Cell],
        options: &ExecOptions,
    ) -> Result<StatementOutcome, DbError> {
        if params.is_empty() {
            self.execute(sql, options).await
        } else {
            Err(DbError {
                message: "This data source does not support statement parameters.".into(),
                detail: None,
                hint: None,
                sqlstate: None,
                position: None,
                connection_lost: false,
                cancelled: false,
            })
        }
    }
    /// Starts loading rows into `table` (`columns` in this order): opens a separate connection,
    /// begins a transaction, runs `setup` (such as CREATE TABLE) and starts a COPY.
    async fn begin_import(
        &self,
        _setup: &[String],
        _table: &TableName,
        _columns: &[String],
    ) -> Result<Box<dyn ImportSink>, DbError> {
        Err(DbError {
            message: "This data source does not support importing files.".into(),
            detail: None,
            hint: None,
            sqlstate: None,
            position: None,
            connection_lost: false,
            cancelled: false,
        })
    }
    /// Delivers notices raised from now on to `sink` (or drops them with `None`).
    fn set_notice_sink(&self, _sink: Option<NoticeSink>) {}
    /// Changes which schemas `metadata` introspects from now on (the profile was edited).
    fn set_schema_scope(&self, _scope: SchemaScope) {}
    /// Cancels statements running longer than `ms` milliseconds (0 = no limit), for this session.
    async fn set_statement_timeout(&self, _ms: u64) -> Result<(), DbError> {
        Ok(())
    }
    /// Asks the server to cancel whatever this session is running. Returns once the request is
    /// delivered; the running `execute` then fails with `cancelled = true`.
    async fn cancel(&self) -> Result<(), DbError>;
    /// Rows `[offset, offset + limit)` of a result cursor returned by `execute`. Only cursors this
    /// session created are accepted.
    async fn fetch(
        &self,
        cursor: &str,
        offset: u64,
        limit: usize,
        options: &ExecOptions,
    ) -> Result<Vec<Vec<Cell>>, DbError>;
    /// Re-runs query `base` (a statement that produced `columns`) with server-side sort/filter
    /// and returns a fresh cursor-backed result. Values are bound, never interpolated.
    async fn refine(
        &self,
        base: &str,
        columns: &[ColumnInfo],
        refinement: &Refinement,
        options: &ExecOptions,
    ) -> Result<StatementOutcome, DbError>;
    /// The statements `apply_edits` would run for `changes`, exactly (SQL plus bound values).
    fn preview_edits(
        &self,
        target: &EditTarget,
        changes: &[RowChange],
    ) -> Result<Vec<EditStatement>, DbError>;
    /// Applies `changes` in one transaction on a separate connection (so an open transaction in
    /// this session is never touched). Each update/delete must affect exactly one row, otherwise
    /// everything is rolled back. Returns the number of changes applied.
    async fn apply_edits(
        &self,
        target: &EditTarget,
        changes: &[RowChange],
    ) -> Result<usize, DbError>;
    /// Releases a result cursor. Unknown or already closed cursors are ignored.
    async fn close_cursor(&self, cursor: &str) -> Result<(), DbError>;
    /// Ends the session; waits for in-flight calls to finish first. Idempotent.
    async fn close(&self);
    /// Drops the connection at once, without waiting: running calls fail as connection lost.
    /// The server may keep running a statement until it notices. `on_close` is not called.
    fn abort(&self);

    /// The transaction state after the last statement or commit/rollback.
    fn tx_status(&self) -> TxStatus;
    fn tx_settings(&self) -> TxSettings;
    /// Takes effect from the next statement; an open transaction is not touched.
    fn set_tx_settings(&self, settings: TxSettings);
    /// Commits the open transaction (a failed one is rolled back by the server) and returns the
    /// new state. Without an open transaction this does nothing.
    async fn commit(&self) -> Result<TxStatus, DbError>;
    /// Rolls back the open transaction, if any, and returns the new state.
    async fn rollback(&self) -> Result<TxStatus, DbError>;
    /// Puts `schema` first in the search path (followed by the server's default path), or restores
    /// the default with `None`. Applies to this session until changed.
    async fn set_schema(&self, schema: Option<&str>) -> Result<(), DbError>;
    /// Opens another session with the same parameters (credentials included), for consoles that
    /// want their own connection and transaction.
    async fn fork(&self, on_close: OnClose) -> Result<Arc<dyn Session>, ConnectError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_debug_redacts_password() {
        let p = ConnectParams {
            host: "h".into(),
            port: 1,
            database: "d".into(),
            username: "u".into(),
            password: Some(SecretString::new("hunter2".into())),
            tls: TlsMode::Prefer,
            connect_timeout: Duration::from_secs(1),
            read_only: false,
            application_name: "quarry".into(),
            options: ConnectOptions {
                startup_sql: "SET role = 'hunter2'".into(),
                ..Default::default()
            },
        };
        let s = format!("{p:?}");
        assert!(!s.contains("hunter2") && s.contains("***"), "{s}");
    }

    #[test]
    fn error_serializes_for_the_ui() {
        let e = ConnectError {
            kind: ConnectErrorKind::DatabaseMissing,
            message: "m".into(),
            hint: "h".into(),
            sqlstate: Some("3D000".into()),
        };
        let json = serde_json::to_value(&e).expect("encode");
        assert_eq!(json["kind"], "database_missing");
        assert_eq!(json["sqlstate"], "3D000");
    }
}
