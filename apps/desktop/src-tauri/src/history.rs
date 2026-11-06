//! IPC surface of the query history (M5.1). Entries are written by query jobs (`exec.rs`); the UI
//! searches, deletes and exports them.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use quarry_db_core::{ColumnInfo, TxMode};
use quarry_io::{ExportWriter, Format, WriteOptions};
use quarry_store::{HistoryEntry, HistoryQuery, HistoryStatus, Store};
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::commands::with_store;
use crate::error::AppError;

/// The most entries one search returns (the popup pages through more).
pub const MAX_PAGE: u32 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum HistoryExportFormat {
    Csv,
    Json,
}

#[tauri::command]
pub async fn history_search(
    store: State<'_, Arc<Store>>,
    query: HistoryQuery,
) -> Result<Vec<HistoryEntry>, AppError> {
    let query = HistoryQuery {
        limit: query.limit.clamp(1, MAX_PAGE),
        ..query
    };
    with_store(&store, move |s| s.search_history(&query)).await
}

/// Removes entries by id; resolves to how many were removed.
#[tauri::command]
pub async fn history_delete(
    store: State<'_, Arc<Store>>,
    ids: Vec<i64>,
) -> Result<usize, AppError> {
    with_store(&store, move |s| s.delete_history(&ids)).await
}

/// Removes every entry of one data source; resolves to how many were removed.
#[tauri::command]
pub async fn history_clear(
    store: State<'_, Arc<Store>>,
    connection_id: String,
) -> Result<usize, AppError> {
    let removed = with_store(&store, move |s| s.clear_history(&connection_id)).await?;
    tracing::info!(removed, "query history cleared");
    Ok(removed)
}

/// Writes every entry matching `query` (ignoring its paging) to a file chosen in the native save
/// dialog. Resolves to the saved path, or `None` when the user cancels.
#[tauri::command]
pub async fn history_export(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    query: HistoryQuery,
    format: HistoryExportFormat,
) -> Result<Option<String>, AppError> {
    let query = HistoryQuery {
        limit: u32::MAX,
        offset: 0,
        ..query
    };
    let (entries, names) = with_store(&store, move |s| {
        let names: HashMap<String, String> = s
            .list_connections()?
            .into_iter()
            .map(|c| (c.id, c.draft.name))
            .collect();
        Ok((s.search_history(&query)?, names))
    })
    .await?;
    let bytes = render(&entries, &names, format)
        .map_err(|e| AppError::new("internal", format!("could not write history: {e}")))?;

    let extension = match format {
        HistoryExportFormat::Csv => "csv",
        HistoryExportFormat::Json => "json",
    };
    // The path comes from the OS dialog, never from the WebView.
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Export query history")
        .set_file_name(format!("query-history.{extension}"))
        .add_filter(extension.to_uppercase(), &[extension]);
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
    let partial = path.with_extension(format!("{extension}.partial"));
    std::fs::write(&partial, &bytes)
        .and_then(|()| std::fs::rename(&partial, &path))
        .map_err(|e| {
            let _ = std::fs::remove_file(&partial);
            AppError::new("storage", format!("could not save {}: {e}", path.display()))
        })?;
    tracing::info!(entries = entries.len(), "query history exported");
    Ok(Some(path.display().to_string()))
}

fn column(name: &str, type_name: &str) -> ColumnInfo {
    ColumnInfo {
        name: name.into(),
        type_name: Some(type_name.into()),
    }
}

/// The export file: one row per entry, newest first.
fn render(
    entries: &[HistoryEntry],
    names: &HashMap<String, String>,
    format: HistoryExportFormat,
) -> std::io::Result<Vec<u8>> {
    let columns = [
        column("started_at", "timestamptz"),
        column("data_source", "text"),
        column("console", "text"),
        column("status", "text"),
        column("duration_ms", "int8"),
        column("rows", "int8"),
        column("transaction_mode", "text"),
        column("error", "text"),
        column("sql", "text"),
    ];
    let format = match format {
        HistoryExportFormat::Csv => Format::Csv,
        HistoryExportFormat::Json => Format::Json,
    };
    let mut writer = ExportWriter::new(Vec::new(), format, &columns, &WriteOptions::default())?;
    let rows: Vec<Vec<Option<String>>> = entries
        .iter()
        .map(|e| {
            vec![
                Some(iso_utc(e.started_at)),
                Some(
                    names
                        .get(&e.connection_id)
                        .cloned()
                        .unwrap_or_else(|| e.connection_id.clone()),
                ),
                e.console.clone(),
                Some(
                    match e.status {
                        HistoryStatus::Ok => "ok",
                        HistoryStatus::Error => "error",
                        HistoryStatus::Cancelled => "cancelled",
                    }
                    .into(),
                ),
                Some(e.duration_ms.to_string()),
                e.row_count.map(|n| n.to_string()),
                Some(
                    match e.tx_mode {
                        TxMode::Auto => "auto",
                        TxMode::Manual => "manual",
                    }
                    .into(),
                ),
                e.error.clone(),
                Some(e.sql.clone()),
            ]
        })
        .collect();
    writer.write_rows(&rows)?;
    Ok(writer.finish()?.0)
}

/// `2026-10-23T08:15:30.123Z` for a Unix time in milliseconds (proleptic Gregorian, UTC).
fn iso_utc(unix_ms: i64) -> String {
    let days = unix_ms.div_euclid(86_400_000);
    let ms_of_day = unix_ms.rem_euclid(86_400_000);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (h, m, s, ms) = (
        ms_of_day / 3_600_000,
        ms_of_day / 60_000 % 60,
        ms_of_day / 1_000 % 60,
        ms_of_day % 1_000,
    );
    format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{ms:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> HistoryEntry {
        HistoryEntry {
            id: 1,
            connection_id: "src".into(),
            console: None,
            sql: "select 1, 'a,b'".into(),
            started_at: 1_792_743_330_123,
            duration_ms: 12,
            status: HistoryStatus::Error,
            row_count: None,
            error: Some("boom".into()),
            tx_mode: TxMode::Manual,
        }
    }

    #[test]
    fn iso_utc_formats_known_instants() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso_utc(1_792_743_330_123), "2026-10-23T08:15:30.123Z");
        assert_eq!(iso_utc(-1), "1969-12-31T23:59:59.999Z");
    }

    #[test]
    fn export_writes_csv_and_json_with_data_source_names() {
        let names = HashMap::from([("src".to_owned(), "Local DB".to_owned())]);
        let csv =
            String::from_utf8(render(&[entry()], &names, HistoryExportFormat::Csv).expect("csv"))
                .expect("utf8");
        assert_eq!(
            csv,
            "started_at,data_source,console,status,duration_ms,rows,transaction_mode,error,sql\n\
             2026-10-23T08:15:30.123Z,Local DB,,error,12,,manual,boom,\"select 1, 'a,b'\"\n"
        );
        let json: serde_json::Value = serde_json::from_slice(
            &render(&[entry()], &HashMap::new(), HistoryExportFormat::Json).expect("json"),
        )
        .expect("parse");
        assert_eq!(json[0]["data_source"], "src");
        assert_eq!(json[0]["duration_ms"], 12);
        assert_eq!(json[0]["rows"], serde_json::Value::Null);
    }
}
