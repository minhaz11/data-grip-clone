//! File import (module I): CSV/TSV and JSON files read as a stream, shaped into rows, checked
//! against the target column types and written to the database with COPY. Memory stays bounded
//! whatever the file size: records are read, converted and sent in small batches.

mod copy;
mod csv;
mod encoding;
mod json;
mod pipeline;
mod types;

use std::io::Read;
use std::ops::ControlFlow;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub use pipeline::{
    ColumnMapping, ErrorPolicy, ImportPlan, ImportProgress, ImportSummary, Rejected, import_file,
};
pub use types::{Converter, infer_type};

/// How a file is laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    /// Delimited text: CSV, TSV and similar.
    Delimited,
    /// One JSON array of objects.
    JsonArray,
    /// One JSON object per line.
    JsonLines,
}

/// Everything needed to read a file into rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ImportFormat {
    pub kind: FileKind,
    /// An Encoding Standard label (`utf-8`, `windows-1252`, `utf-16le`, ...); `None` detects it.
    pub encoding: Option<String>,
    /// Delimited files: the field separator.
    pub delimiter: char,
    pub quote: char,
    /// A character that escapes the next one inside quotes; `None` means quotes are doubled.
    pub escape: Option<char>,
    /// The first record holds the column names.
    pub header: bool,
    /// Removes spaces around unquoted values.
    pub trim: bool,
    /// An unquoted value equal to this is NULL (`\N`, `NULL`, ...).
    pub null_token: Option<String>,
    /// An unquoted empty value is NULL; a quoted empty one (`""`) stays an empty string.
    pub empty_is_null: bool,
}

impl Default for ImportFormat {
    fn default() -> Self {
        Self {
            kind: FileKind::Delimited,
            encoding: None,
            delimiter: ',',
            quote: '"',
            escape: None,
            header: true,
            trim: false,
            null_token: None,
            empty_is_null: true,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    #[error("could not read the file: {0}")]
    Io(#[from] std::io::Error),
    #[error("unknown encoding \"{0}\"")]
    Encoding(String),
    /// The file does not follow the format (unterminated quote, invalid JSON).
    #[error("{message} (line {line})")]
    Syntax { line: u64, message: String },
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Database(String),
}

/// One record as read: its first line in the file (or position in a JSON array) and its values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub line: u64,
    pub values: Vec<Option<String>>,
}

/// What a quick look at the start of a file suggests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    pub format: ImportFormat,
    /// The encoding the sample was decoded with.
    pub encoding: String,
}

/// Guesses the layout and encoding from the first bytes of a file.
pub fn detect(path: &Path) -> Result<Detected, ImportError> {
    let mut head = Vec::with_capacity(64 * 1024);
    std::fs::File::open(path)?
        .take(64 * 1024)
        .read_to_end(&mut head)?;
    let enc = encoding::detect(&head);
    let (text, _, _) = enc.decode(&head);
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let kind = if trimmed.starts_with('[') {
        FileKind::JsonArray
    } else if trimmed.starts_with('{') || ext == "jsonl" || ext == "ndjson" {
        FileKind::JsonLines
    } else {
        FileKind::Delimited
    };
    let delimiter = if ext == "tsv" || ext == "tab" {
        '\t'
    } else {
        csv::guess_delimiter(&text)
    };
    Ok(Detected {
        format: ImportFormat {
            kind,
            encoding: None,
            delimiter,
            ..ImportFormat::default()
        },
        encoding: enc.name().to_owned(),
    })
}

/// Column names: the header record (or `column_1`, ...) for delimited files, the keys of the
/// first objects for JSON. Then the first `limit` data records, shaped to those columns.
pub fn preview(
    path: &Path,
    format: &ImportFormat,
    limit: usize,
) -> Result<(Vec<String>, Vec<Record>), ImportError> {
    let mut columns: Option<Vec<String>> = None;
    let mut rows = Vec::new();
    let mut objects = Vec::new();
    read_records(path, format, None, &mut |raw| {
        match raw {
            Raw::Values(record) if columns.is_none() && format.header => {
                columns = Some(header_names(&record.values));
            }
            Raw::Values(record) => rows.push(record),
            Raw::Object(line, object) => objects.push((line, object)),
        }
        if rows.len() + objects.len() >= limit {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })?;
    if !objects.is_empty() || matches!(format.kind, FileKind::JsonArray | FileKind::JsonLines) {
        let mut names: Vec<String> = Vec::new();
        for (_, object) in &objects {
            for key in object.keys() {
                if !names.contains(key) {
                    names.push(key.clone());
                }
            }
        }
        let rows = objects
            .into_iter()
            .map(|(line, object)| json::shape(line, &object, &names))
            .collect();
        return Ok((names, rows));
    }
    let width = rows.iter().map(|r| r.values.len()).max().unwrap_or(0);
    let columns = columns.unwrap_or_else(|| (1..=width).map(|i| format!("column_{i}")).collect());
    Ok((columns, rows))
}

fn header_names(values: &[Option<String>]) -> Vec<String> {
    values
        .iter()
        .enumerate()
        .map(|(i, v)| match v.as_deref().map(str::trim) {
            Some(name) if !name.is_empty() => name.to_owned(),
            _ => format!("column_{}", i + 1),
        })
        .collect()
}

/// A record before it is shaped: delimited values, or a JSON object.
pub(crate) enum Raw {
    Values(Record),
    Object(u64, serde_json::Map<String, serde_json::Value>),
}

/// Reads every record of `path`, calling `each` until it breaks. `counter` sees the bytes read
/// (for progress).
pub(crate) fn read_records(
    path: &Path,
    format: &ImportFormat,
    counter: Option<std::sync::Arc<std::sync::atomic::AtomicU64>>,
    each: &mut dyn FnMut(Raw) -> ControlFlow<()>,
) -> Result<(), ImportError> {
    let file = std::fs::File::open(path)?;
    let file = encoding::Counting::new(file, counter);
    let reader = encoding::decoder(file, format.encoding.as_deref())?;
    match format.kind {
        FileKind::Delimited => csv::read(reader, format, &mut |r| each(Raw::Values(r))),
        FileKind::JsonArray => json::read_array(reader, &mut |line, o| each(Raw::Object(line, o))),
        FileKind::JsonLines => json::read_lines(reader, &mut |line, o| each(Raw::Object(line, o))),
    }
}
