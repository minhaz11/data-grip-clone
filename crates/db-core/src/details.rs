//! Everything about one table-like object at once, for the table viewer and quick info (M4.3).

use serde::{Deserialize, Serialize};

use crate::ObjectType;

/// A table, view or materialized view, by schema and name.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub schema: String,
    pub name: String,
    pub object_type: ObjectType,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ColumnDetail {
    pub name: String,
    /// Full type, e.g. `character varying(80)`.
    pub type_name: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub primary_key: bool,
    /// `always` / `by default` for identity columns.
    pub identity: Option<String>,
    /// Expression of a generated column.
    pub generated: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IndexDetail {
    pub name: String,
    /// The server's definition after `USING`, e.g. `btree (email)`.
    pub definition: String,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConstraintDetail {
    pub name: String,
    /// `primary key`, `unique`, `check`, `exclusion`, `foreign key`.
    pub kind: String,
    /// The server's definition, e.g. `CHECK ((qty > 0))`.
    pub definition: String,
}

/// A foreign key, seen from either side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDetail {
    pub name: String,
    /// The referencing table (for incoming keys) or this table (for outgoing ones).
    pub from_schema: String,
    pub from_table: String,
    pub from_columns: Vec<String>,
    pub to_schema: String,
    pub to_table: String,
    pub to_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
    pub deferrable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TriggerDetail {
    pub name: String,
    /// The definition without `CREATE TRIGGER name`, e.g. `AFTER INSERT ON s.t FOR EACH ROW …`.
    pub definition: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ObjectDetails {
    pub object: ObjectRef,
    pub comment: Option<String>,
    pub columns: Vec<ColumnDetail>,
    pub indexes: Vec<IndexDetail>,
    /// Primary key, unique, check and exclusion constraints (foreign keys are below).
    pub constraints: Vec<ConstraintDetail>,
    /// Foreign keys this object declares.
    pub references: Vec<ForeignKeyDetail>,
    /// Foreign keys in other tables that point at this one.
    pub referenced_by: Vec<ForeignKeyDetail>,
    pub triggers: Vec<TriggerDetail>,
    /// The planner's row estimate; absent until the table has been analyzed.
    pub row_estimate: Option<u64>,
    /// Table plus indexes and TOAST, in bytes (absent for views).
    pub total_bytes: Option<u64>,
}
