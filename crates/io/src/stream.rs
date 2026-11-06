//! Streaming a cursor-backed result to a file or into memory (for the clipboard). Both can be
//! cancelled between pages; a cancelled or failed export never leaves a file behind.

use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use quarry_db_core::{Cell, ColumnInfo, DbError, ExecOptions, Session};

use crate::{ExportWriter, Format, WriteOptions};

const PAGE_ROWS: usize = 5_000;

#[derive(Debug)]
pub enum StreamError {
    Db(DbError),
    /// Writing failed (disk full, permissions); the message names the path.
    Io(String),
    /// Copying stopped because the text would exceed the clipboard limit.
    TooLarge {
        limit: usize,
    },
}

impl From<DbError> for StreamError {
    fn from(e: DbError) -> Self {
        Self::Db(e)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportOutcome {
    Written { rows: u64, bytes: u64 },
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopyOutcome {
    Copied { text: String, rows: u64 },
    Cancelled,
}

/// Full values: no cell clipping.
fn full_values() -> ExecOptions {
    ExecOptions {
        max_cell_chars: usize::MAX,
        ..ExecOptions::default()
    }
}

/// The temporary file an export writes before it is renamed into place.
pub fn partial_path(path: &Path, format: Format) -> PathBuf {
    path.with_extension(format!("{}.partial", format.extension()))
}

/// Streams the whole result behind `cursor` to `path`. Rows go to a writer thread through a small
/// bounded queue, so fetching never runs far ahead of the disk. The file is written as
/// `<path>.<ext>.partial` and renamed at the end; on cancel or error the partial file is removed.
#[allow(clippy::too_many_arguments)] // every argument is a distinct part of the request
pub async fn export_to_file(
    session: &dyn Session,
    cursor: &str,
    columns: &[ColumnInfo],
    format: Format,
    options: &WriteOptions,
    path: &Path,
    cancel: &AtomicBool,
    on_progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<ExportOutcome, StreamError> {
    let partial = partial_path(path, format);
    let (tx, rx) = mpsc::sync_channel::<Vec<Vec<Cell>>>(2);
    let writer = {
        let partial = partial.clone();
        let columns = columns.to_vec();
        let options = options.clone();
        std::thread::spawn(move || -> std::io::Result<u64> {
            let mut w = ExportWriter::new(
                BufWriter::with_capacity(256 * 1024, File::create(&partial)?),
                format,
                &columns,
                &options,
            )?;
            for page in rx {
                w.write_rows(&page)?;
            }
            Ok(w.finish()?.1)
        })
    };

    let options_db = full_values();
    let mut offset = 0u64;
    let mut cancelled = false;
    let fetched: Result<(), DbError> = async {
        loop {
            if cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            let page = session
                .fetch(cursor, offset, PAGE_ROWS, &options_db)
                .await?;
            let n = page.len();
            if n == 0 {
                break;
            }
            offset += n as u64;
            if tx.send(page).is_err() {
                break; // the writer failed; its error is reported below
            }
            on_progress(offset);
            if n < PAGE_ROWS {
                break;
            }
        }
        Ok(())
    }
    .await;
    drop(tx);
    let written = writer
        .join()
        .unwrap_or_else(|_| Err(std::io::Error::other("export writer panicked")));

    match (fetched, written, cancelled) {
        (Ok(()), Ok(_), true) => {
            let _ = std::fs::remove_file(&partial);
            Ok(ExportOutcome::Cancelled)
        }
        (Ok(()), Ok(rows), false) => {
            std::fs::rename(&partial, path).map_err(|e| {
                let _ = std::fs::remove_file(&partial);
                StreamError::Io(format!("could not save {}: {e}", path.display()))
            })?;
            let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            Ok(ExportOutcome::Written { rows, bytes })
        }
        (fetched, written, _) => {
            let _ = std::fs::remove_file(&partial); // never leave a half-written export behind
            fetched?;
            let e = written
                .err()
                .map_or_else(|| "unknown error".to_owned(), |e| e.to_string());
            Err(StreamError::Io(format!(
                "could not write {}: {e}",
                path.display()
            )))
        }
    }
}

/// Formats the whole result behind `cursor` in memory, stopping with `TooLarge` once the text
/// passes `max_bytes`.
#[allow(clippy::too_many_arguments)] // every argument is a distinct part of the request
pub async fn copy_to_string(
    session: &dyn Session,
    cursor: &str,
    columns: &[ColumnInfo],
    format: Format,
    options: &WriteOptions,
    max_bytes: usize,
    cancel: &AtomicBool,
    on_progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<CopyOutcome, StreamError> {
    let io_error = |e: std::io::Error| StreamError::Io(e.to_string());
    let mut w = ExportWriter::new(Vec::new(), format, columns, options).map_err(io_error)?;
    let options_db = full_values();
    let mut offset = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(CopyOutcome::Cancelled);
        }
        let page = session
            .fetch(cursor, offset, PAGE_ROWS, &options_db)
            .await?;
        let n = page.len();
        if n == 0 {
            break;
        }
        offset += n as u64;
        w.write_rows(&page).map_err(io_error)?;
        if w.out.len() > max_bytes {
            return Err(StreamError::TooLarge { limit: max_bytes });
        }
        on_progress(offset);
        if n < PAGE_ROWS {
            break;
        }
    }
    let (bytes, rows) = w.finish().map_err(io_error)?;
    let text = String::from_utf8(bytes).map_err(|e| StreamError::Io(e.to_string()))?;
    Ok(CopyOutcome::Copied { text, rows })
}
