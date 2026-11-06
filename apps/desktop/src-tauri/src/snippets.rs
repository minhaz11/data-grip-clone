//! User snippets (M5.5): CRUD, and import/export as JSON through the native dialogs (paths never
//! come from the WebView).

use std::sync::Arc;

use quarry_store::{Snippet, SnippetDraft, SnippetFile, Store};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;

type AppStore<'a> = State<'a, Arc<Store>>;

async fn blocking<T, F>(store: &Arc<Store>, f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&Store) -> Result<T, AppError> + Send + 'static,
{
    let store = Arc::clone(store);
    tauri::async_runtime::spawn_blocking(move || f(&store))
        .await
        .map_err(|e| AppError::new("internal", format!("snippet task failed: {e}")))?
}

/// What an import did.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SnippetImport {
    pub added: usize,
    pub replaced: usize,
}

#[tauri::command]
pub async fn snippets_list(store: AppStore<'_>) -> Result<Vec<Snippet>, AppError> {
    blocking(&store, |s| Ok(s.list_snippets()?)).await
}

/// Creates a snippet, or updates `snippet_id` when given.
#[tauri::command]
pub async fn snippet_save(
    store: AppStore<'_>,
    snippet_id: Option<String>,
    draft: SnippetDraft,
) -> Result<Snippet, AppError> {
    blocking(&store, move |s| {
        Ok(match snippet_id {
            Some(id) => s.update_snippet(&id, draft)?,
            None => s.insert_snippet(&uuid::Uuid::new_v4().to_string(), draft)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn snippet_delete(store: AppStore<'_>, snippet_id: String) -> Result<(), AppError> {
    blocking(&store, move |s| {
        s.delete_snippet(&snippet_id)?;
        Ok(())
    })
    .await
}

/// Saves every user snippet as JSON; the path, or `None` if cancelled.
#[tauri::command]
pub async fn snippets_export(
    app: AppHandle,
    store: AppStore<'_>,
) -> Result<Option<String>, AppError> {
    let file = blocking(&store, |s| Ok(s.export_snippets()?)).await?;
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export Snippets")
        .set_file_name("quarry-snippets.json")
        .add_filter("JSON", &["json"]);
    if let Ok(dir) = app.path().document_dir() {
        dialog = dialog.set_directory(dir);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| AppError::new("internal", format!("dialog failed: {e}")))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| AppError::new("invalid", e.to_string()))?;
    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| AppError::new("internal", e.to_string()))?;
    std::fs::write(&path, json)
        .map_err(|e| AppError::new("storage", format!("could not save {}: {e}", path.display())))?;
    Ok(Some(path.display().to_string()))
}

/// Reads snippets from a JSON file chosen in the native dialog; `None` if cancelled.
#[tauri::command]
pub async fn snippets_import(
    app: AppHandle,
    store: AppStore<'_>,
) -> Result<Option<SnippetImport>, AppError> {
    let dialog = app
        .dialog()
        .file()
        .set_title("Import Snippets")
        .add_filter("JSON", &["json"]);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|e| AppError::new("internal", format!("dialog failed: {e}")))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| AppError::new("invalid", e.to_string()))?;
    blocking(&store, move |s| {
        let meta = std::fs::metadata(&path).map_err(|e| {
            AppError::new("storage", format!("cannot read {}: {e}", path.display()))
        })?;
        if meta.len() > 32 << 20 {
            return Err(AppError::new(
                "invalid",
                "The file is too large for a snippets file.",
            ));
        }
        let text = std::fs::read_to_string(&path).map_err(|e| {
            AppError::new("storage", format!("cannot read {}: {e}", path.display()))
        })?;
        let file: SnippetFile = serde_json::from_str(&text).map_err(|e| {
            AppError::new(
                "invalid",
                format!("This is not a Quarry snippets file: {e}"),
            )
        })?;
        let (added, replaced) =
            s.import_snippets(file, &mut || uuid::Uuid::new_v4().to_string())?;
        Ok(Some(SnippetImport { added, replaced }))
    })
    .await
}
