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
        .map_err(|e| AppError::new("internal", format!("task failed: {e}")))?
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
pub async fn connection_delete(
    manager: Manager<'_>,
    sessions: Live<'_>,
    id: String,
) -> Result<(), AppError> {
    sessions.disconnect(&id).await;
    run(&manager, move |m| m.delete(&id)).await
}

// ---- Connectivity (M2.2) ----

use quarry_db_core::{MetaNode, MetadataRequest, ServerInfo};
use tauri::AppHandle;

use crate::sessions::{SessionStatus, Sessions};

type Live<'a> = State<'a, Arc<Sessions>>;

/// Tests a (possibly unsaved) draft. `id` lets an edited profile reuse its stored password;
/// an explicit `password` (typed in the dialog) wins.
#[tauri::command]
pub async fn connection_test(
    manager: Manager<'_>,
    sessions: Live<'_>,
    draft: ConnectionDraft,
    id: Option<String>,
    password: Option<SecretString>,
) -> Result<ServerInfo, AppError> {
    let params = run(&manager, move |m| {
        let pw = m.resolve_password(id.as_deref(), password)?;
        quarry_connections::connect_params(draft, pw)
    })
    .await?;
    sessions.test(&params).await
}

#[tauri::command]
pub async fn connection_connect(
    app: AppHandle,
    manager: Manager<'_>,
    sessions: Live<'_>,
    id: String,
    password: Option<SecretString>,
) -> Result<ServerInfo, AppError> {
    let key = id.clone();
    let params = run(&manager, move |m| {
        let profile = m.profile(&key)?;
        let pw = m.resolve_password(Some(&key), password)?;
        quarry_connections::connect_params(profile.draft, pw)
    })
    .await?;
    sessions.inner().connect(&app, &id, &params).await
}

#[tauri::command]
pub async fn connection_disconnect(sessions: Live<'_>, id: String) -> Result<(), AppError> {
    sessions.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn sessions_list(sessions: Live<'_>) -> Result<Vec<SessionStatus>, AppError> {
    Ok(sessions.list().await)
}

/// One level of the explorer tree for a connected data source.
#[tauri::command]
pub async fn metadata_children(
    sessions: Live<'_>,
    id: String,
    request: MetadataRequest,
) -> Result<Vec<MetaNode>, AppError> {
    sessions.metadata(&id, &request).await
}
