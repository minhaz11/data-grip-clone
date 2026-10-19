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
            StoreError::NewerSchema { .. } => "incompatible_storage",
            _ => "storage",
        };
        Self {
            kind,
            message: err.to_string(),
        }
    }
}
