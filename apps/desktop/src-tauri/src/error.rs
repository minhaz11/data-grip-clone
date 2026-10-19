use quarry_connections::ConnectionError;
use quarry_store::StoreError;
use serde::Serialize;

/// The only error shape that crosses IPC. Messages are user-facing and never contain secrets.
#[derive(Debug, Serialize)]
pub struct AppError {
    pub kind: &'static str,
    pub message: String,
}

impl From<StoreError> for AppError {
    fn from(err: StoreError) -> Self {
        let kind = match err {
            StoreError::Invalid(_) => "invalid",
            StoreError::NotFound(_) => "not_found",
            StoreError::NewerSchema { .. } => "incompatible_storage",
            _ => "storage",
        };
        Self {
            kind,
            message: err.to_string(),
        }
    }
}

impl From<ConnectionError> for AppError {
    fn from(err: ConnectionError) -> Self {
        match err {
            ConnectionError::Store(e) => e.into(),
            ConnectionError::Secret(e) => Self {
                kind: "credential_store",
                message: e.to_string(),
            },
            ConnectionError::Invalid(m) => Self {
                kind: "invalid",
                message: m,
            },
            ConnectionError::NotFound => Self {
                kind: "not_found",
                message: err.to_string(),
            },
        }
    }
}
