//! Paging and exporting result sets held in server-side cursors. Pages are bounded so no single
//! IPC message grows with the result; exports stream from the cursor to disk in Rust and never
//! pass row data through the WebView.

use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc;

use quarry_db_core::{
    Cell, ColumnInfo, EditStatement, EditTarget, ExecOptions, Refinement, RowChange,
    StatementOutcome,
};
use quarry_io::{ExportWriter, Format};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;
use crate::sessions::{SessionKey, Sessions};

pub const MAX_PAGE_ROWS: usize = 2_000;
const EXPORT_PAGE_ROWS: usize = 5_000;

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
    let columns: Vec<ColumnInfo> = columns
        .into_iter()
        .map(|c| ColumnInfo {
            name: c.name,
            type_name: c.type_name,
        })
        .collect();
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
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ExportColumn {
    pub name: String,
    pub type_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub path: String,
    pub rows: u64,
    pub bytes: u64,
}

/// Asks for a destination with the native save dialog, then streams the whole result to it.
/// Resolves to `None` when the user cancels the dialog.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // every argument is a distinct IPC field
pub async fn result_export(
    app: AppHandle,
    sessions: State<'_, Arc<Sessions>>,
    session: SessionKey,
    cursor: String,
    columns: Vec<ExportColumn>,
    format: ExportFormat,
    file_name: String,
    on_progress: Channel<u64>,
) -> Result<Option<ExportSummary>, AppError> {
    let live = sessions.get(&session).await?;
    let format = match format {
        ExportFormat::Csv => Format::Csv,
        ExportFormat::Json => Format::Json,
    };
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

    let columns: Vec<ColumnInfo> = columns
        .into_iter()
        .map(|c| ColumnInfo {
            name: c.name,
            type_name: c.type_name,
        })
        .collect();
    let partial = path.with_extension(format!("{ext}.partial"));

    // Writer thread with a small bounded queue: fetching never runs far ahead of the disk.
    let (tx, rx) = mpsc::sync_channel::<Vec<Vec<Cell>>>(2);
    let writer = {
        let partial = partial.clone();
        let columns = columns.clone();
        std::thread::spawn(move || -> std::io::Result<u64> {
            let mut w = ExportWriter::new(
                BufWriter::with_capacity(256 * 1024, File::create(&partial)?),
                format,
                &columns,
            )?;
            for page in rx {
                w.write_rows(&page)?;
            }
            Ok(w.finish()?.1)
        })
    };

    // Full values for export: no cell clipping.
    let options = ExecOptions {
        max_cell_chars: usize::MAX,
        ..ExecOptions::default()
    };
    let mut offset = 0u64;
    let fetch_result: Result<(), AppError> = async {
        loop {
            let page = live
                .fetch(&cursor, offset, EXPORT_PAGE_ROWS, &options)
                .await?;
            let n = page.len();
            if n == 0 {
                break;
            }
            offset += n as u64;
            if tx.send(page).is_err() {
                break; // writer failed; its error is reported below
            }
            let _ = on_progress.send(offset);
            if n < EXPORT_PAGE_ROWS {
                break;
            }
        }
        Ok(())
    }
    .await;
    drop(tx);
    let written = writer
        .join()
        .map_err(|_| AppError::new("internal", "export writer panicked"))?;

    match (fetch_result, written) {
        (Ok(()), Ok(rows)) => {
            std::fs::rename(&partial, &path).map_err(|e| {
                AppError::new("storage", format!("could not save {}: {e}", path.display()))
            })?;
            let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            // The destination path is the user's; counts are enough to diagnose.
            tracing::info!(source = %session.source_id, rows, bytes, "export finished");
            Ok(Some(ExportSummary {
                path: path.display().to_string(),
                rows,
                bytes,
            }))
        }
        (fetched, written) => {
            let _ = std::fs::remove_file(&partial); // never leave a half-written export behind
            tracing::warn!(source = %session.source_id, "export failed");
            fetched?;
            let e = written
                .err()
                .map_or_else(|| "unknown error".to_owned(), |e| e.to_string());
            Err(AppError::new(
                "storage",
                format!("could not write {}: {e}", path.display()),
            ))
        }
    }
}

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
