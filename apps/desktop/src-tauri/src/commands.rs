use std::sync::Arc;

use quarry_store::{Settings, Store, StoreError};
use tauri::State;

use crate::error::AppError;

/// Runs a store call on the blocking pool so SQLite I/O never stalls the main (UI event) thread.
pub(crate) async fn with_store<T, F>(store: &Arc<Store>, f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&Store) -> Result<T, StoreError> + Send + 'static,
{
    let store = Arc::clone(store);
    tauri::async_runtime::spawn_blocking(move || f(&store))
        .await
        .map_err(|e| AppError::new("internal", format!("storage task failed: {e}")))?
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn settings_get(store: State<'_, Arc<Store>>) -> Result<Settings, AppError> {
    with_store(&store, |s| s.settings()).await
}

#[tauri::command]
pub async fn settings_set(
    store: State<'_, Arc<Store>>,
    settings: Settings,
) -> Result<Settings, AppError> {
    with_store(&store, move |s| {
        let saved = s.set_settings(&settings)?;
        // A smaller history limit applies at once, not only after the next run.
        s.prune_history(saved.history_retention(), crate::exec::unix_millis())?;
        Ok(saved)
    })
    .await
}

#[tauri::command]
pub async fn workspace_get(
    store: State<'_, Arc<Store>>,
) -> Result<Option<serde_json::Value>, AppError> {
    with_store(&store, |s| s.workspace()).await
}

#[tauri::command]
pub async fn workspace_set(
    store: State<'_, Arc<Store>>,
    state: serde_json::Value,
) -> Result<(), AppError> {
    with_store(&store, move |s| s.set_workspace(&state)).await
}
