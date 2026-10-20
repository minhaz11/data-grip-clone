//! Statement execution contract: one statement in, one outcome out. Scripts are run statement by
//! statement by the caller, which owns ordering, stop-on-error and cancellation.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecOptions {
    /// Rows kept for display; further rows are counted but not returned.
    pub max_rows: usize,
    /// Characters kept per cell; longer values are cut and marked.
    pub max_cell_chars: usize,
}

impl Default for ExecOptions {
    fn default() -> Self {
        Self {
            max_rows: 500,
            max_cell_chars: 10_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    /// Engine type name ("int4", "text", ...) when the statement could be described.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub type_name: Option<String>,
}

/// A cell as the server renders it in text form; `None` is SQL NULL. Text form keeps numeric,
/// int8 and timestamp values exact (no lossy JS numbers).
pub type Cell = Option<String>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum StatementOutcome {
    Rows {
        columns: Vec<ColumnInfo>,
        rows: Vec<Vec<Cell>>,
        /// All rows the statement produced (may exceed `rows.len()`).
        total_rows: u64,
        /// `rows` is a prefix of the full result.
        truncated: bool,
    },
    /// No result set: DML/DDL/utility. `rows_affected` is 0 for statements without a count.
    Command { rows_affected: u64 },
}

/// Where an error points, as a 1-based character offset into the statement text that was sent.
pub type ErrorPosition = u32;
