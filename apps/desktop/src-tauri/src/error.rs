use quarry_connections::ConnectionError;
use quarry_db_core::{ConnectError, ConnectErrorKind, DbError};
use quarry_store::StoreError;
use quarry_workspace::ConsoleError;
use serde::Serialize;

/// The only error shape that crosses IPC. Messages are user-facing and never contain secrets.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub sqlstate: Option<String>,
    /// Set when `kind == "connect"`: which connection failure it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub connect_kind: Option<ConnectErrorKind>,
    /// Set for `ssh_host_unknown` and `ssh_host_changed`: the key to show the user.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub host_key: Option<Box<HostKeyPrompt>>,
    /// `Some(true)` when the failure happened while opening the SSH tunnel, before the database
    /// was reached.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub tunnel: Option<bool>,
}

/// An SSH server's host key, for the "trust this host?" prompt.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HostKeyPrompt {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    /// SHA-256 fingerprint as OpenSSH prints it (`SHA256:…`).
    pub fingerprint: String,
    /// The fingerprint trusted before, when the key changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub expected: Option<String>,
}

impl AppError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            hint: None,
            sqlstate: None,
            connect_kind: None,
            host_key: None,
            tunnel: None,
        }
    }
}

impl From<StoreError> for AppError {
    fn from(err: StoreError) -> Self {
        let kind = match err {
            StoreError::Invalid(_) => "invalid",
            StoreError::NotFound(_) => "not_found",
            StoreError::NewerSchema { .. } => "incompatible_storage",
            _ => "storage",
        };
        Self::new(kind, err.to_string())
    }
}

impl From<ConnectionError> for AppError {
    fn from(err: ConnectionError) -> Self {
        match err {
            ConnectionError::Store(e) => e.into(),
            ConnectionError::Secret(e) => Self::new("credential_store", e.to_string()),
            ConnectionError::Invalid(m) => Self::new("invalid", m),
            ConnectionError::NotFound => Self::new("not_found", err.to_string()),
        }
    }
}

impl From<ConsoleError> for AppError {
    fn from(e: ConsoleError) -> Self {
        let kind = match e {
            ConsoleError::InvalidName(_) | ConsoleError::TooLarge(_) => "invalid",
            ConsoleError::NotFound(_) => "not_found",
            ConsoleError::Io(_) => "storage",
        };
        Self::new(kind, e.to_string())
    }
}

impl From<DbError> for AppError {
    fn from(e: DbError) -> Self {
        let message = match &e.detail {
            Some(d) => format!("{} ({d})", e.message),
            None => e.message,
        };
        Self {
            kind: if e.connection_lost {
                "connection_lost"
            } else {
                "db"
            },
            message,
            hint: e.hint,
            sqlstate: e.sqlstate,
            connect_kind: None,
            host_key: None,
            tunnel: None,
        }
    }
}

impl From<ConnectError> for AppError {
    fn from(e: ConnectError) -> Self {
        Self {
            kind: "connect",
            message: e.message,
            hint: Some(e.hint),
            sqlstate: e.sqlstate,
            connect_kind: Some(e.kind),
            host_key: None,
            tunnel: None,
        }
    }
}
