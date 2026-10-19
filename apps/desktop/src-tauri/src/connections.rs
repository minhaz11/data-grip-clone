//! IPC surface of the connection manager. Passwords may be sent *in*; nothing here returns one.

use std::sync::Arc;

use quarry_connections::{ConnectionError, ConnectionManager, PasswordChange};
use quarry_secrets::SecretString;
use quarry_store::{ConnectionDraft, ConnectionProfile};
use tauri::State;

use crate::error::AppError;

type Manager<'a> = State<'a, Arc<ConnectionManager>>;

/// Keyring and SQLite calls block (D-Bus, disk); keep them off the main thread.
async fn run<T, F>(manager: &Arc<ConnectionManager>, f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&ConnectionManager) -> Result<T, ConnectionError> + Send + 'static,
{
    let manager = Arc::clone(manager);
    tauri::async_runtime::spawn_blocking(move || f(&manager))
        .await
        .map_err(|e| AppError {
            kind: "internal",
            message: format!("task failed: {e}"),
        })?
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn connections_list(manager: Manager<'_>) -> Result<Vec<ConnectionProfile>, AppError> {
    run(&manager, |m| m.list()).await
}

#[tauri::command]
pub async fn connection_create(
    manager: Manager<'_>,
    draft: ConnectionDraft,
    password: Option<SecretString>,
) -> Result<ConnectionProfile, AppError> {
    run(&manager, move |m| m.create(draft, password)).await
}

#[tauri::command]
pub async fn connection_update(
    manager: Manager<'_>,
    id: String,
    draft: ConnectionDraft,
    password: Option<PasswordChange>,
) -> Result<ConnectionProfile, AppError> {
    run(&manager, move |m| {
        m.update(&id, draft, password.unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn connection_duplicate(
    manager: Manager<'_>,
    id: String,
) -> Result<ConnectionProfile, AppError> {
    run(&manager, move |m| m.duplicate(&id)).await
}

#[tauri::command]
pub async fn connection_delete(manager: Manager<'_>, id: String) -> Result<(), AppError> {
    run(&manager, move |m| m.delete(&id)).await
}
