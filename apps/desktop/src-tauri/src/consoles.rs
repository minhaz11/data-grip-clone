//! IPC for file-backed consoles. Consoles are addressed by name; the backend owns the directory.

use std::sync::Arc;

use quarry_workspace::{ConsoleError, Consoles};
use tauri::State;

use crate::error::AppError;

type Store<'a> = State<'a, Arc<Consoles>>;

async fn run<T, F>(consoles: &Arc<Consoles>, f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&Consoles) -> Result<T, ConsoleError> + Send + 'static,
{
    let consoles = Arc::clone(consoles);
    tauri::async_runtime::spawn_blocking(move || f(&consoles))
        .await
        .map_err(|e| AppError::new("internal", format!("console task failed: {e}")))?
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn console_list(consoles: Store<'_>) -> Result<Vec<String>, AppError> {
    run(&consoles, |c| c.list()).await
}

/// Returns the new console's name (`preferred` when it is free and valid).
#[tauri::command]
pub async fn console_create(
    consoles: Store<'_>,
    preferred: Option<String>,
) -> Result<String, AppError> {
    run(&consoles, move |c| c.create(preferred.as_deref())).await
}

#[tauri::command]
pub async fn console_read(consoles: Store<'_>, name: String) -> Result<String, AppError> {
    run(&consoles, move |c| c.read(&name)).await
}

#[tauri::command]
pub async fn console_write(
    consoles: Store<'_>,
    name: String,
    text: String,
) -> Result<(), AppError> {
    run(&consoles, move |c| c.write(&name, &text)).await
}
