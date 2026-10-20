use quarry_connections::ConnectionError;
use quarry_db_core::{ConnectError, ConnectErrorKind, DbError};
use quarry_store::StoreError;
use quarry_workspace::ConsoleError;
use serde::Serialize;

/// The only error shape that crosses IPC. Messages are user-facing and never contain secrets.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sqlstate: Option<String>,
    /// Set when `kind == "connect"`: which connection failure it was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_kind: Option<ConnectErrorKind>,
}

impl AppError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            hint: None,
            sqlstate: None,
            connect_kind: None,
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
        }
    }
}
