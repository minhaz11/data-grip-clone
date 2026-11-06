//! IPC surface for DDL generation (M4.4).

use std::path::PathBuf;
use std::sync::Arc;

use quarry_db_core::{DdlObject, DdlOptions};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;
use crate::results::sanitize;
use crate::sessions::{SessionKey, Sessions};

type Live<'a> = State<'a, Arc<Sessions>>;

async fn generate(
    sessions: &Sessions,
    id: &str,
    objects: &[DdlObject],
    options: &DdlOptions,
) -> Result<String, AppError> {
    if objects.is_empty() {
        return Err(AppError::new("invalid", "Nothing to generate DDL for."));
    }
    let live = sessions.get(&SessionKey::shared(id)).await?;
    let script = live.ddl(objects, options).await?;
    tracing::info!(source = %id, objects = objects.len(), bytes = script.len(), "ddl generated");
    Ok(script)
}

#[tauri::command]
pub async fn ddl_generate(
    sessions: Live<'_>,
    id: String,
    objects: Vec<DdlObject>,
    options: DdlOptions,
) -> Result<String, AppError> {
    generate(&sessions, &id, &objects, &options).await
}

/// Generates the DDL, asks for a destination with the native save dialog and writes it there.
/// Resolves to the saved path, or `None` when the user cancels.
#[tauri::command]
pub async fn ddl_save(
    app: AppHandle,
    sessions: Live<'_>,
    id: String,
    objects: Vec<DdlObject>,
    options: DdlOptions,
    file_name: String,
) -> Result<Option<String>, AppError> {
    // Generate first, so a failure shows before any dialog.
    let script = generate(&sessions, &id, &objects, &options).await?;
    // The path comes from the OS dialog, never from the WebView.
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save DDL")
        .set_file_name(format!("{}.sql", sanitize(&file_name)))
        .add_filter("SQL", &["sql"]);
    if let Ok(dir) = app.path().document_dir() {
        dialog = dialog.set_directory(dir);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| AppError::new("internal", format!("dialog failed: {e}")))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path: PathBuf = picked
        .into_path()
        .map_err(|e| AppError::new("invalid", e.to_string()))?;
    // Written next to the target first, then renamed: never a half-written file.
    let partial = path.with_extension("sql.partial");
    std::fs::write(&partial, script.as_bytes())
        .and_then(|()| std::fs::rename(&partial, &path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&partial);
            AppError::new("storage", format!("could not save {}: {e}", path.display()))
        })?;
    tracing::info!(source = %id, bytes = script.len(), "ddl saved");
    Ok(Some(path.display().to_string()))
}
