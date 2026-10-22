//! Engine-neutral adapter contract (ADR-0002). The UI and app layer only see these types; each
//! engine crate (`quarry-db-postgres`, later MySQL/SQLite) implements [`DatabaseAdapter`].

mod exec;
mod metadata;

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use quarry_secrets::SecretString;
use serde::Serialize;

pub use exec::{
    Cell, ColumnInfo, ErrorPosition, ExecOptions, Filter, FilterOp, Refinement, SortKey,
    StatementOutcome,
};
pub use metadata::{MetaKind, MetaNode, MetadataRequest, ObjectType};

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
}

/// A failure while using an open session (as opposed to [`ConnectError`] while opening one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
    /// Releases a result cursor. Unknown or already closed cursors are ignored.
    async fn close_cursor(&self, cursor: &str) -> Result<(), DbError>;
    /// Ends the session; waits for in-flight calls to finish first. Idempotent.
    async fn close(&self);
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
