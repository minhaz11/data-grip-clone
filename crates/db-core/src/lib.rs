//! Engine-neutral adapter contract (ADR-0002). The UI and app layer only see these types; each
//! engine crate (`quarry-db-postgres`, later MySQL/SQLite) implements [`DatabaseAdapter`].

mod ddl;
mod details;
mod exec;
mod metadata;
mod schema;
mod tx;

use std::fmt;
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
    ErrorPosition, ExecOptions, Filter, FilterOp, Refinement, RowChange, SortKey, StatementOutcome,
};
pub use metadata::{MetaKind, MetaNode, MetadataRequest, ObjectType};
pub use schema::{
    CheckModel, ColumnModel, DropObject, FkAction, ForeignKeyModel, Identity, IndexModel, KeyModel,
    RenameObject, SchemaChange, TableModel, TableName,
};
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
