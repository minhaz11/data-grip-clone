//! Paging and exporting result sets held in server-side cursors. Pages are bounded so no single
//! IPC message grows with the result; exports stream from the cursor to disk in Rust and never
//! pass row data through the WebView.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use quarry_db_core::{
    Cell, ColumnInfo, EditStatement, EditTarget, ExecOptions, Refinement, RowChange,
    StatementOutcome, TableName,
};
use quarry_io::{CopyOutcome, ExportOutcome, Format, StreamError, WriteOptions};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;
use crate::sessions::{SessionKey, Sessions};

pub const MAX_PAGE_ROWS: usize = 2_000;

#[tauri::command]
pub async fn result_page(
    sessions: State<'_, Arc<Sessions>>,
    session: SessionKey,
    cursor: String,
    offset: u64,
    limit: usize,
) -> Result<Vec<Vec<Cell>>, AppError> {
    let live = sessions.get(&session).await?;
    let limit = limit.clamp(1, MAX_PAGE_ROWS);
    Ok(live
        .fetch(&cursor, offset, limit, &ExecOptions::default())
        .await?)
}

#[tauri::command]
pub async fn result_close(
    sessions: State<'_, Arc<Sessions>>,
    session: SessionKey,
    cursor: String,
) -> Result<(), AppError> {
    // A closed session already dropped its cursors.
    match sessions.get(&session).await {
        Ok(live) => Ok(live.close_cursor(&cursor).await?),
        Err(_) => Ok(()),
    }
}

/// Re-runs a query result's statement with server-side sort/filter and releases the previous
/// cursor. `sql` is the statement the user ran; values in `refinement` are bound, not spliced.
#[tauri::command]
pub async fn result_refine(
    sessions: State<'_, Arc<Sessions>>,
    session: SessionKey,
    sql: String,
    columns: Vec<ExportColumn>,
    refinement: Refinement,
    previous_cursor: Option<String>,
    schema: Option<String>,
) -> Result<StatementOutcome, AppError> {
    let live = sessions.get(&session).await?;
    // The re-run must resolve names the way the original run did.
    sessions
        .apply_schema(&session, &live, schema.as_deref())
        .await?;
    let columns = column_infos(columns);
    let outcome = live
        .refine(&sql, &columns, &refinement, &ExecOptions::default())
        .await?;
    if let Some(previous) = previous_cursor {
        let _ = live.close_cursor(&previous).await;
    }
    Ok(outcome)
}

/// The exact statements (SQL + bound values) that `result_apply_edits` would run.
#[tauri::command]
pub async fn result_preview_edits(
    sessions: State<'_, Arc<Sessions>>,
    session: SessionKey,
    target: EditTarget,
    changes: Vec<RowChange>,
) -> Result<Vec<EditStatement>, AppError> {
    let live = sessions.get(&session).await?;
    Ok(live.preview_edits(&target, &changes)?)
}

/// Applies row changes in one transaction (all or nothing); returns how many were applied.
#[tauri::command]
pub async fn result_apply_edits(
    sessions: State<'_, Arc<Sessions>>,
    session: SessionKey,
    target: EditTarget,
    changes: Vec<RowChange>,
) -> Result<usize, AppError> {
    let live = sessions.get(&session).await?;
    match live.apply_edits(&target, &changes).await {
        Ok(applied) => {
            tracing::info!(source = %session.source_id, changes = applied, "row changes applied");
            Ok(applied)
        }
        Err(e) => {
            tracing::warn!(
                source = %session.source_id,
                changes = changes.len(),
                sqlstate = e.sqlstate.as_deref().unwrap_or(""),
                "row changes rolled back"
            );
            Err(e.into())
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Csv,
    Tsv,
    Json,
    Sql,
    Markdown,
}

impl From<ExportFormat> for Format {
    fn from(format: ExportFormat) -> Self {
        match format {
            ExportFormat::Csv => Format::Csv,
            ExportFormat::Tsv => Format::Tsv,
            ExportFormat::Json => Format::Json,
            ExportFormat::Sql => Format::SqlInsert,
            ExportFormat::Markdown => Format::Markdown,
        }
    }
}

/// How values are written; see `quarry_io::WriteOptions`.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    #[cfg_attr(test, ts(optional = nullable))]
    pub null_text: Option<String>,
    #[serde(default)]
    pub quote_all: bool,
    #[serde(default = "yes")]
    pub header: bool,
    /// SQL INSERT target; absent uses a placeholder name.
    #[cfg_attr(test, ts(optional = nullable))]
    pub table: Option<TableName>,
}

fn yes() -> bool {
    true
}

impl From<ExportOptions> for WriteOptions {
    fn from(o: ExportOptions) -> Self {
        WriteOptions {
            null_text: o.null_text,
            quote_all: o.quote_all,
            header: o.header,
            table: o.table,
        }
    }
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ExportColumn {
    pub name: String,
    pub type_name: Option<String>,
}

fn column_infos(columns: Vec<ExportColumn>) -> Vec<ColumnInfo> {
    columns
        .into_iter()
        .map(|c| ColumnInfo {
            name: c.name,
            type_name: c.type_name,
        })
        .collect()
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub path: String,
    pub rows: u64,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CopySummary {
    pub rows: u64,
    pub bytes: u64,
}

/// Running exports and whole-result copies, by the job id the UI chose, so they can be cancelled.
#[derive(Default)]
pub struct Exports {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Exports {
    fn start(&self, job: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.lock().insert(job.to_owned(), Arc::clone(&flag));
        flag
    }

    fn finish(&self, job: &str) {
        self.lock().remove(job);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.running.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Text copied from a whole result is capped; larger results should be exported to a file.
const MAX_COPY_BYTES: usize = 64 * 1024 * 1024;

fn stream_error(e: StreamError) -> AppError {
    match e {
        StreamError::Db(e) => e.into(),
        StreamError::Io(message) => AppError::new("storage", message),
        StreamError::TooLarge { limit } => AppError::new(
            "invalid",
            format!(
                "The result is larger than {} MB as text, too large for the clipboard. Export it to a file instead.",
                limit / (1024 * 1024)
            ),
        ),
    }
}

/// Asks for a destination with the native save dialog, then streams the whole result to it.
/// Resolves to `None` when the user cancels the dialog or the export (`result_export_cancel`).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // every argument is a distinct IPC field
pub async fn result_export(
    app: AppHandle,
    sessions: State<'_, Arc<Sessions>>,
    exports: State<'_, Arc<Exports>>,
    session: SessionKey,
    cursor: String,
    columns: Vec<ExportColumn>,
    format: ExportFormat,
    options: ExportOptions,
    file_name: String,
    job: String,
    on_progress: Channel<u64>,
) -> Result<Option<ExportSummary>, AppError> {
    let live = sessions.get(&session).await?;
    let _busy = sessions.busy(&session.source_id);
    let format = Format::from(format);
    let ext = format.extension();
    let suggested = format!("{}.{ext}", sanitize(&file_name));

    // The path comes from the OS dialog, never from the WebView.
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export result")
        .set_file_name(suggested)
        .add_filter(ext.to_uppercase(), &[ext]);
    // Start in Downloads rather than the process working directory (which may be the repo).
    if let Ok(dir) = app.path().download_dir() {
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

    let cancel = exports.start(&job);
    let outcome = quarry_io::export_to_file(
        live.as_ref(),
        &cursor,
        &column_infos(columns),
        format,
        &options.into(),
        &path,
        &cancel,
        &|rows| {
            let _ = on_progress.send(rows);
        },
    )
    .await;
    exports.finish(&job);
    match outcome {
        Ok(ExportOutcome::Written { rows, bytes }) => {
            // The destination path is the user's; counts are enough to diagnose.
            tracing::info!(source = %session.source_id, rows, bytes, "export finished");
            Ok(Some(ExportSummary {
                path: path.display().to_string(),
                rows,
                bytes,
            }))
        }
        Ok(ExportOutcome::Cancelled) => {
            tracing::info!(source = %session.source_id, "export cancelled");
            Ok(None)
        }
        Err(e) => {
            tracing::warn!(source = %session.source_id, "export failed");
            Err(stream_error(e))
        }
    }
}

/// Copies the whole result to the clipboard from Rust, so its text never passes through the
/// WebView. Resolves to `None` when cancelled.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // every argument is a distinct IPC field
pub async fn result_copy(
    app: AppHandle,
    sessions: State<'_, Arc<Sessions>>,
    exports: State<'_, Arc<Exports>>,
    session: SessionKey,
    cursor: String,
    columns: Vec<ExportColumn>,
    format: ExportFormat,
    options: ExportOptions,
    job: String,
    on_progress: Channel<u64>,
) -> Result<Option<CopySummary>, AppError> {
    let live = sessions.get(&session).await?;
    let _busy = sessions.busy(&session.source_id);
    let cancel = exports.start(&job);
    let outcome = quarry_io::copy_to_string(
        live.as_ref(),
        &cursor,
        &column_infos(columns),
        format.into(),
        &options.into(),
        MAX_COPY_BYTES,
        &cancel,
        &|rows| {
            let _ = on_progress.send(rows);
        },
    )
    .await;
    exports.finish(&job);
    match outcome.map_err(stream_error)? {
        CopyOutcome::Copied { text, rows } => {
            let bytes = text.len() as u64;
            app.clipboard()
                .write_text(text)
                .map_err(|e| AppError::new("internal", format!("clipboard: {e}")))?;
            tracing::info!(source = %session.source_id, rows, bytes, "result copied");
            Ok(Some(CopySummary { rows, bytes }))
        }
        CopyOutcome::Cancelled => Ok(None),
    }
}

/// Stops a running export or copy between pages; unknown jobs are ignored.
#[tauri::command]
pub fn result_export_cancel(exports: State<'_, Arc<Exports>>, job: String) {
    if let Some(flag) = exports.lock().get(&job) {
        flag.store(true, Ordering::Relaxed);
    }
}

/// Formats rows the UI already holds (a copied selection) with the export writers.
#[tauri::command]
pub fn result_format(
    columns: Vec<ExportColumn>,
    rows: Vec<Vec<Cell>>,
    format: ExportFormat,
    options: ExportOptions,
) -> Result<String, AppError> {
    if rows.len() > MAX_FORMAT_ROWS {
        return Err(AppError::new(
            "invalid",
            format!("At most {MAX_FORMAT_ROWS} rows can be copied as a selection."),
        ));
    }
    quarry_io::format_rows(
        format.into(),
        &column_infos(columns),
        &rows,
        &options.into(),
    )
    .map_err(|e| AppError::new("internal", e.to_string()))
}

/// Selections larger than this are copied with the whole-result copy instead.
pub const MAX_FORMAT_ROWS: usize = 100_000;

/// A file-name suggestion: letters, digits, `-`, `_`, `.`, at most 80 characters.
pub(crate) fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    let trimmed = cleaned.trim_matches(['.', '_']);
    if trimmed.is_empty() {
        "result".to_owned()
    } else {
        trimmed.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize;

    #[test]
    fn sanitize_keeps_names_safe() {
        assert_eq!(sanitize("orders 2026/10"), "orders_2026_10");
        assert_eq!(sanitize("../../etc/passwd"), "etc_passwd");
        assert_eq!(sanitize(""), "result");
        assert_eq!(sanitize("console_1"), "console_1");
    }
}
