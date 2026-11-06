//! The import run: a blocking reader parses, checks and encodes rows in batches; the async side
//! writes them to the database's COPY. A small bounded channel between the two keeps memory flat
//! whatever the file size. Any failure or a cancel rolls the whole import back.

use std::ops::ControlFlow;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use quarry_db_core::{Session, TableName};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::copy::encode_row;
use super::types::Converter;
use super::{FileKind, ImportError, ImportFormat, Raw, Record, json, read_records};

/// What to do with a row whose value does not fit its column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ErrorPolicy {
    /// Stop and roll everything back.
    Abort,
    /// Leave the row out and list it.
    Skip,
    /// Load the row with NULL for the values that do not fit, and list them.
    Null,
}

/// One target column and where its values come from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ColumnMapping {
    /// Index into the source columns.
    pub source: usize,
    pub target: String,
    /// The target column's type, for checking values before they are sent.
    pub type_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportPlan {
    pub format: ImportFormat,
    /// The file's columns, as the preview found them (JSON keys, or the header/positions).
    pub source_columns: Vec<String>,
    pub mapping: Vec<ColumnMapping>,
    pub table: TableName,
    /// Statements run first in the same transaction (CREATE TABLE for a new table).
    pub setup: Vec<String>,
    pub policy: ErrorPolicy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    pub rows: u64,
    pub rejected: u64,
    pub bytes: u64,
    pub total_bytes: u64,
}

/// A row that was left out (or loaded with NULLs), and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Rejected {
    /// Line in the file (record number for a JSON array).
    pub line: u64,
    pub column: Option<String>,
    pub message: String,
    /// Loaded with NULL instead of left out.
    pub nulled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub rows: u64,
    /// The first rejected rows (at most `MAX_LISTED`); `rejected_count` has them all.
    pub rejected: Vec<Rejected>,
    pub rejected_count: u64,
    /// Values set to NULL under the NULL policy.
    pub nulled: u64,
    pub elapsed_ms: u64,
    /// Cancelled: nothing was loaded.
    pub cancelled: bool,
}

/// Rejected rows kept in the summary.
pub const MAX_LISTED: usize = 1_000;
const BATCH_ROWS: usize = 1_000;
const BATCH_BYTES: usize = 1 << 20;

enum Batch {
    Rows {
        data: Vec<u8>,
        rows: u64,
        rejected: Vec<Rejected>,
        rejected_count: u64,
        nulled: u64,
    },
    Failed(ImportError),
}

/// Imports `path` according to `plan`. Cancelling (or any failure) rolls everything back.
pub async fn import_file(
    session: &dyn Session,
    path: &Path,
    plan: &ImportPlan,
    cancel: &AtomicBool,
    on_progress: &(dyn Fn(ImportProgress) + Send + Sync),
) -> Result<ImportSummary, ImportError> {
    let started = Instant::now();
    let total_bytes = std::fs::metadata(path)?.len();
    let columns: Vec<String> = plan.mapping.iter().map(|m| m.target.clone()).collect();
    let mut sink = session
        .begin_import(&plan.setup, &plan.table, &columns)
        .await
        .map_err(|e| ImportError::Database(e.message))?;

    let (tx, mut rx) = mpsc::channel::<Batch>(4);
    let read = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let reader = {
        let (path, plan) = (path.to_owned(), plan.clone());
        let (read, stop) = (Arc::clone(&read), Arc::clone(&stop));
        tokio::task::spawn_blocking(move || produce(&path, &plan, read, &stop, &tx))
    };

    let mut summary = ImportSummary {
        rows: 0,
        rejected: Vec::new(),
        rejected_count: 0,
        nulled: 0,
        elapsed_ms: 0,
        cancelled: false,
    };
    let mut reported = Instant::now();
    let progress = |s: &ImportSummary| ImportProgress {
        rows: s.rows,
        rejected: s.rejected_count,
        bytes: read.load(Ordering::Relaxed),
        total_bytes,
    };
    let failure = loop {
        let next = tokio::select! {
            b = rx.recv() => b,
            () = tokio::time::sleep(Duration::from_millis(100)) => {
                if cancel.load(Ordering::Relaxed) {
                    break None;
                }
                continue;
            }
        };
        if cancel.load(Ordering::Relaxed) {
            break None;
        }
        match next {
            None => break Some(Ok(())),
            Some(Batch::Failed(e)) => break Some(Err(e)),
            Some(Batch::Rows {
                data,
                rows,
                rejected,
                rejected_count,
                nulled,
            }) => {
                if let Err(e) = sink.write(data).await {
                    break Some(Err(ImportError::Database(e.message)));
                }
                summary.rows += rows;
                summary.rejected_count += rejected_count;
                summary.nulled += nulled;
                let room = MAX_LISTED.saturating_sub(summary.rejected.len());
                summary.rejected.extend(rejected.into_iter().take(room));
                if reported.elapsed() >= Duration::from_millis(200) {
                    reported = Instant::now();
                    on_progress(progress(&summary));
                }
            }
        }
    };
    stop.store(true, Ordering::Relaxed);
    // Unblocks the reader if it waits on a full channel.
    drop(rx);
    let read_result = reader
        .await
        .map_err(|e| ImportError::Invalid(format!("the reader stopped: {e}")))?;

    match failure {
        None => {
            sink.abort().await;
            summary.cancelled = true;
            summary.rows = 0;
        }
        Some(Err(e)) => {
            sink.abort().await;
            return Err(e);
        }
        Some(Ok(())) => {
            if let Err(e) = read_result {
                sink.abort().await;
                return Err(e);
            }
            summary.rows = sink
                .finish()
                .await
                .map_err(|e| ImportError::Database(e.message))?;
        }
    }
    summary.elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    on_progress(progress(&summary));
    Ok(summary)
}

/// Reads, checks and encodes rows, sending batches until the file ends, `stop` is set or the
/// receiver is gone.
fn produce(
    path: &Path,
    plan: &ImportPlan,
    read: Arc<AtomicU64>,
    stop: &AtomicBool,
    tx: &mpsc::Sender<Batch>,
) -> Result<(), ImportError> {
    let converters: Vec<Converter> = plan
        .mapping
        .iter()
        .map(|m| Converter::for_type(&m.type_name))
        .collect();
    let width = plan.source_columns.len();
    let delimited = plan.format.kind == FileKind::Delimited;
    let mut skip_header = delimited && plan.format.header;
    let mut batch = Vec::with_capacity(BATCH_BYTES + 4096);
    let (mut rows, mut nulled, mut rejected_count) = (0u64, 0u64, 0u64);
    let mut rejected: Vec<Rejected> = Vec::new();
    let mut failed: Option<ImportError> = None;
    let mut values: Vec<Option<String>> = Vec::with_capacity(plan.mapping.len());

    let send = |batch: &mut Vec<u8>,
                rows: &mut u64,
                rejected: &mut Vec<Rejected>,
                rejected_count: &mut u64,
                nulled: &mut u64|
     -> ControlFlow<()> {
        let b = Batch::Rows {
            data: std::mem::replace(batch, Vec::with_capacity(BATCH_BYTES + 4096)),
            rows: std::mem::take(rows),
            rejected: std::mem::take(rejected),
            rejected_count: std::mem::take(rejected_count),
            nulled: std::mem::take(nulled),
        };
        if tx.blocking_send(b).is_err() {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };

    let result = read_records(path, &plan.format, Some(read), &mut |raw| {
        if stop.load(Ordering::Relaxed) {
            return ControlFlow::Break(());
        }
        let record = match raw {
            Raw::Values(_) if skip_header => {
                skip_header = false;
                return ControlFlow::Continue(());
            }
            Raw::Values(r) => r,
            Raw::Object(line, object) => json::shape(line, &object, &plan.source_columns),
        };
        match check(&record, plan, &converters, width, delimited, &mut values) {
            Ok(nulls) => {
                encode_row(&mut batch, values.iter().map(Option::as_deref));
                rows += 1;
                if !nulls.is_empty() {
                    nulled += nulls.len() as u64;
                    rejected_count += 1;
                    rejected.extend(nulls);
                }
            }
            Err(problem) if plan.policy == ErrorPolicy::Abort => {
                failed = Some(ImportError::Invalid(format!(
                    "Line {}{}: {}. Nothing was imported.",
                    problem.line,
                    problem
                        .column
                        .as_deref()
                        .map(|c| format!(", column {c}"))
                        .unwrap_or_default(),
                    problem.message
                )));
                return ControlFlow::Break(());
            }
            Err(problem) => {
                rejected_count += 1;
                if rejected.len() < MAX_LISTED {
                    rejected.push(problem);
                }
            }
        }
        if rows as usize >= BATCH_ROWS || batch.len() >= BATCH_BYTES {
            return send(
                &mut batch,
                &mut rows,
                &mut rejected,
                &mut rejected_count,
                &mut nulled,
            );
        }
        ControlFlow::Continue(())
    });
    if let Some(e) = failed {
        let _ = tx.blocking_send(Batch::Failed(e));
        return Ok(());
    }
    if let Err(e) = result {
        let _ = tx.blocking_send(Batch::Failed(e));
        return Ok(());
    }
    if rows > 0 || rejected_count > 0 {
        let _ = send(
            &mut batch,
            &mut rows,
            &mut rejected,
            &mut rejected_count,
            &mut nulled,
        );
    }
    Ok(())
}

/// Fills `values` with the record's converted values for the mapped columns. Under the NULL
/// policy, values that do not fit become NULL and are returned as notes; otherwise the first
/// problem is the error.
fn check(
    record: &Record,
    plan: &ImportPlan,
    converters: &[Converter],
    width: usize,
    delimited: bool,
    values: &mut Vec<Option<String>>,
) -> Result<Vec<Rejected>, Rejected> {
    values.clear();
    if delimited && record.values.len() != width {
        let problem = Rejected {
            line: record.line,
            column: None,
            message: format!(
                "has {} values; the file has {width} columns",
                record.values.len()
            ),
            nulled: false,
        };
        if plan.policy != ErrorPolicy::Null || record.values.len() > width {
            return Err(problem);
        }
    }
    let mut nulls = Vec::new();
    for (m, conv) in plan.mapping.iter().zip(converters) {
        let raw = record.values.get(m.source).cloned().flatten();
        let Some(raw) = raw else {
            values.push(None);
            continue;
        };
        match conv.convert(&raw) {
            Ok(v) => values.push(Some(v.into_owned())),
            Err(message) => {
                let problem = Rejected {
                    line: record.line,
                    column: Some(m.target.clone()),
                    message,
                    nulled: plan.policy == ErrorPolicy::Null,
                };
                if plan.policy != ErrorPolicy::Null {
                    return Err(problem);
                }
                values.push(None);
                nulls.push(problem);
            }
        }
    }
    Ok(nulls)
}
