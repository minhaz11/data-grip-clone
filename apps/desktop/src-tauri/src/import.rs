//! File import (M5.4). Files are opened only when the user picked them in the native dialog or
//! dropped them on the window: Rust records the path and the WebView gets an id, a name and a
//! bounded preview sample, never the means to read other files or the whole file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use quarry_db_core::Cell;
use quarry_io::import::{
    Detected, ImportError, ImportFormat, ImportPlan, ImportProgress, ImportSummary, Rejected,
};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;
use crate::sessions::{SessionKey, Sessions};

pub const FILE_DROPPED_EVENT: &str = "file-dropped";

/// Rows read for type inference; the preview shows at most `MAX_PREVIEW_ROWS` of them.
const SAMPLE_ROWS: usize = 1_000;
const MAX_PREVIEW_ROWS: usize = 200;

/// A file the user chose for import.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub detected: Detected,
}

/// A dropped file and where it was dropped (logical pixels in the window).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub file: ImportFile,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub columns: Vec<String>,
    /// The type each column's sample values fit best.
    pub inferred: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
    /// Line of each preview row in the file.
    pub lines: Vec<u64>,
    /// Rows the whole file probably has, from the sample's average size.
    pub estimated_rows: u64,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event"
)]
pub enum ImportEvent {
    Progress(ImportProgress),
    Done(ImportSummary),
    Failed { error: AppError },
}

#[derive(Default)]
pub struct Imports {
    files: Mutex<HashMap<String, PathBuf>>,
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// The rejected rows of finished imports, for Save error log.
    rejected: Mutex<HashMap<String, Vec<Rejected>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Imports {
    /// Records a path the user chose, and describes the file.
    pub fn register(&self, path: PathBuf) -> Result<ImportFile, AppError> {
        let size = std::fs::metadata(&path)
            .map_err(|e| AppError::new("storage", format!("cannot read {}: {e}", path.display())))?
            .len();
        if !path.is_file() {
            return Err(AppError::new("invalid", "Only files can be imported."));
        }
        let detected = quarry_io::import::detect(&path).map_err(import_error)?;
        let id = uuid::Uuid::new_v4().to_string();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        lock(&self.files).insert(id.clone(), path);
        Ok(ImportFile {
            id,
            name,
            size,
            detected,
        })
    }

    fn path(&self, file_id: &str) -> Result<PathBuf, AppError> {
        lock(&self.files)
            .get(file_id)
            .cloned()
            .ok_or_else(|| AppError::new("not_found", "Choose the file again."))
    }
}

pub fn import_error(e: ImportError) -> AppError {
    match e {
        ImportError::Database(message) => AppError::new("db", message),
        ImportError::Io(e) => AppError::new("storage", e.to_string()),
        other => AppError::new("invalid", other.to_string()),
    }
}

/// Native open dialog for a CSV, TSV or JSON file; `None` if cancelled.
#[tauri::command]
pub async fn import_pick(
    app: AppHandle,
    imports: State<'_, Arc<Imports>>,
) -> Result<Option<ImportFile>, AppError> {
    let dialog = app
        .dialog()
        .file()
        .set_title("Import Data From File")
        .add_filter(
            "Data files",
            &["csv", "tsv", "txt", "tab", "json", "jsonl", "ndjson"],
        )
        .add_filter("All files", &["*"]);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|e| AppError::new("internal", format!("dialog failed: {e}")))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| AppError::new("invalid", e.to_string()))?;
    let imports = Arc::clone(&imports);
    tauri::async_runtime::spawn_blocking(move || imports.register(path).map(Some))
        .await
        .map_err(|e| AppError::new("internal", format!("task failed: {e}")))?
}

/// Columns, inferred types and the first rows of a chosen file read with `format`.
#[tauri::command]
pub async fn import_preview(
    imports: State<'_, Arc<Imports>>,
    file_id: String,
    format: ImportFormat,
    limit: usize,
) -> Result<ImportPreview, AppError> {
    let path = imports.path(&file_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (columns, records) =
            quarry_io::import::preview(&path, &format, SAMPLE_ROWS).map_err(import_error)?;
        let inferred = (0..columns.len())
            .map(|i| {
                quarry_io::import::infer_type(
                    records
                        .iter()
                        .map(|r| r.values.get(i).and_then(|v| v.as_deref())),
                )
                .to_owned()
            })
            .collect();
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let sample_bytes: usize = records
            .iter()
            .map(|r| {
                r.values
                    .iter()
                    .map(|v| v.as_deref().map_or(1, str::len) + 1)
                    .sum::<usize>()
            })
            .sum();
        let estimated_rows = if records.len() < SAMPLE_ROWS || sample_bytes == 0 {
            records.len() as u64
        } else {
            size.saturating_mul(records.len() as u64) / sample_bytes as u64
        };
        let shown = records.into_iter().take(limit.clamp(1, MAX_PREVIEW_ROWS));
        let (lines, rows) = shown.map(|r| (r.line, r.values)).unzip();
        Ok(ImportPreview {
            columns,
            inferred,
            rows,
            lines,
            estimated_rows,
        })
    })
    .await
    .map_err(|e| AppError::new("internal", format!("task failed: {e}")))?
}

/// Starts an import into the shared session's database; returns the job id at once. Progress,
/// then Done or Failed, arrive on `on_event`.
#[tauri::command]
pub async fn import_run(
    imports: State<'_, Arc<Imports>>,
    sessions: State<'_, Arc<Sessions>>,
    file_id: String,
    source_id: String,
    plan: ImportPlan,
    on_event: Channel<ImportEvent>,
) -> Result<String, AppError> {
    let path = imports.path(&file_id)?;
    let session = sessions.get(&SessionKey::shared(&source_id)).await?;
    let busy = sessions.busy(&source_id);
    let job = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    lock(&imports.running).insert(job.clone(), Arc::clone(&cancel));
    tracing::info!(
        job = %job,
        source = %source_id,
        columns = plan.mapping.len(),
        policy = ?plan.policy,
        new_table = !plan.setup.is_empty(),
        "import started"
    );
    let imports = Arc::clone(&imports);
    let id = job.clone();
    tauri::async_runtime::spawn(async move {
        let _busy = busy;
        let progress = {
            let channel = on_event.clone();
            move |p: ImportProgress| {
                let _ = channel.send(ImportEvent::Progress(p));
            }
        };
        let result =
            quarry_io::import::import_file(session.as_ref(), &path, &plan, &cancel, &progress)
                .await;
        lock(&imports.running).remove(&id);
        match result {
            Ok(summary) => {
                tracing::info!(
                    job = %id,
                    rows = summary.rows,
                    rejected = summary.rejected_count,
                    cancelled = summary.cancelled,
                    ms = summary.elapsed_ms,
                    "import finished"
                );
                lock(&imports.rejected).insert(id, summary.rejected.clone());
                let _ = on_event.send(ImportEvent::Done(summary));
            }
            Err(e) => {
                tracing::warn!(job = %id, error = %e, "import failed");
                let _ = on_event.send(ImportEvent::Failed {
                    error: import_error(e),
                });
            }
        }
    });
    Ok(job)
}

#[tauri::command]
pub async fn import_cancel(imports: State<'_, Arc<Imports>>, job: String) -> Result<(), AppError> {
    if let Some(flag) = lock(&imports.running).get(&job) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Saves the rejected rows of a finished import as CSV via the native dialog; the path, or
/// `None` if cancelled.
#[tauri::command]
pub async fn import_errors_save(
    app: AppHandle,
    imports: State<'_, Arc<Imports>>,
    job: String,
) -> Result<Option<String>, AppError> {
    let rejected = lock(&imports.rejected)
        .get(&job)
        .cloned()
        .ok_or_else(|| AppError::new("not_found", "That import's errors are no longer kept."))?;
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save Import Errors")
        .set_file_name("import-errors.csv")
        .add_filter("CSV", &["csv"]);
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
    let mut text = String::from("line,column,action,message\n");
    let field = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
    for r in &rejected {
        text.push_str(&format!(
            "{},{},{},{}\n",
            r.line,
            field(r.column.as_deref().unwrap_or("")),
            if r.nulled { "set to NULL" } else { "skipped" },
            field(&r.message)
        ));
    }
    std::fs::write(&path, text)
        .map_err(|e| AppError::new("storage", format!("could not save {}: {e}", path.display())))?;
    Ok(Some(path.display().to_string()))
}

/// Registers files dropped on the window and tells the UI where they landed.
pub fn on_drop(app: &AppHandle, paths: &[PathBuf], x: f64, y: f64) {
    let imports = app.state::<Arc<Imports>>();
    for path in paths {
        match imports.register(path.clone()) {
            Ok(file) => {
                let _ = app.emit(FILE_DROPPED_EVENT, DroppedFile { file, x, y });
            }
            Err(e) => tracing::warn!(error = %e.message, "dropped file not usable"),
        }
    }
}
