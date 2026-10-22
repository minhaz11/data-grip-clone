//! Statement execution contract: one statement in, one outcome out. Scripts are run statement by
//! statement by the caller, which owns ordering, stop-on-error and cancellation.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecOptions {
    /// Rows in the first page (and the cap for results that cannot be paged).
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
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum StatementOutcome {
    Rows {
        columns: Vec<ColumnInfo>,
        rows: Vec<Vec<Cell>>,
        /// All rows the statement produced (may exceed `rows.len()`).
        total_rows: u64,
        /// `rows` is a prefix of the full result.
        truncated: bool,
        /// Server-side cursor holding the full result, for paging and export. `None` for results
        /// that cannot be kept in a cursor (e.g. `INSERT … RETURNING`, `SHOW`); those return at
        /// most `max_rows` rows.
        #[serde(skip_serializing_if = "Option::is_none")]
        cursor: Option<String>,
        /// Whether rows can be edited (only computed for cursor-backed query results).
        #[serde(skip_serializing_if = "Option::is_none")]
        edit: Option<Editability>,
    },
    /// No result set: DML/DDL/utility. `rows_affected` is 0 for statements without a count.
    Command { rows_affected: u64 },
}

/// Where an error points, as a 1-based character offset into the statement text that was sent.
pub type ErrorPosition = u32;

#[cfg(test)]
mod tests {
    use super::*;

    /// The UI reads camelCase fields; internally tagged enums need `rename_all_fields` for that.
    #[test]
    fn outcome_json_uses_camel_case_fields() {
        let rows = StatementOutcome::Rows {
            columns: vec![ColumnInfo {
                name: "id".into(),
                type_name: Some("int4".into()),
            }],
            rows: vec![vec![Some("1".into()), None]],
            total_rows: 10,
            truncated: true,
            cursor: Some("c".into()),
            edit: None,
        };
        assert_eq!(
            serde_json::to_value(&rows).expect("encode"),
            serde_json::json!({
                "type": "rows",
                "columns": [{ "name": "id", "typeName": "int4" }],
                "rows": [["1", null]],
                "totalRows": 10,
                "truncated": true,
                "cursor": "c"
            })
        );
        let cmd = StatementOutcome::Command { rows_affected: 3 };
        assert_eq!(
            serde_json::to_value(&cmd).expect("encode"),
            serde_json::json!({ "type": "command", "rowsAffected": 3 })
        );
    }
}

/// Server-side sort and filter applied to a query result by re-running it (module D). Columns are
/// referenced by position in the original result, never by name or SQL text.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Refinement {
    /// Applied in order (first key sorts first).
    #[serde(default)]
    pub sort: Vec<SortKey>,
    /// All must hold (AND).
    #[serde(default)]
    pub filters: Vec<Filter>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub column: usize,
    pub descending: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: usize,
    pub op: FilterOp,
    /// Text form of the comparison value; `None` for `IsNull`/`NotNull`.
    pub value: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    /// Case-insensitive substring match on the text form.
    Contains,
    /// Case-insensitive prefix match on the text form.
    StartsWith,
    IsNull,
    NotNull,
}

impl FilterOp {
    pub fn takes_value(self) -> bool {
        !matches!(self, FilterOp::IsNull | FilterOp::NotNull)
    }
}

/// Whether a result's rows can be edited, decided from the columns' source tables (as reported by
/// the server), never from SQL text.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum Editability {
    Editable { target: EditTarget },
    ReadOnly { reason: String },
}

/// The single base table a result's rows come from.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTarget {
    pub schema: String,
    pub table: String,
    /// Per result column: the base column it shows, or `None` if it cannot be edited
    /// (computed, from another table, a repeat of an earlier column, or an unsupported type).
    pub columns: Vec<Option<EditColumn>>,
    /// Result-column positions of the primary key, in key order.
    pub key: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditColumn {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnValue {
    /// Result-column position.
    pub column: usize,
    pub value: Cell,
}

/// One pending row change. Rows are identified by their primary-key values as last read.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum RowChange {
    /// `original` holds the edited columns' values as read; the update applies only if they are
    /// unchanged on the server (optimistic locking).
    Update {
        key: Vec<Cell>,
        set: Vec<ColumnValue>,
        original: Vec<ColumnValue>,
    },
    Delete {
        key: Vec<Cell>,
    },
    Insert {
        values: Vec<ColumnValue>,
    },
}

/// A generated statement exactly as it will run: SQL with placeholders plus bound values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditStatement {
    pub sql: String,
    pub params: Vec<Cell>,
}
