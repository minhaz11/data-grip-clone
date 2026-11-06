//! Schema changes from forms (M4.5): a table model for Create/Modify Table, and the other
//! changes (drop, truncate, rename). Builders turn them into exact statements for preview and
//! apply; names are always quoted by the builder, never taken as SQL.

use serde::{Deserialize, Serialize};

use crate::ObjectType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum Identity {
    Always,
    ByDefault,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum FkAction {
    #[default]
    NoAction,
    Restrict,
    Cascade,
    SetNull,
    SetDefault,
}

impl FkAction {
    pub fn sql(self) -> &'static str {
        match self {
            Self::NoAction => "NO ACTION",
            Self::Restrict => "RESTRICT",
            Self::Cascade => "CASCADE",
            Self::SetNull => "SET NULL",
            Self::SetDefault => "SET DEFAULT",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ColumnModel {
    pub name: String,
    /// The column's name in the catalog (Modify Table); absent for a new column.
    pub original: Option<String>,
    /// A type name such as `integer`, `character varying(80)` or `timestamp with time zone`.
    pub type_name: String,
    pub not_null: bool,
    /// A SQL expression, used as written.
    pub default: Option<String>,
    pub identity: Option<Identity>,
    pub comment: Option<String>,
}

/// A unique constraint (or the primary key) over columns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct KeyModel {
    /// The constraint's name; absent lets the server choose one.
    pub name: Option<String>,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct CheckModel {
    pub name: Option<String>,
    /// A boolean SQL expression, used as written.
    pub expression: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyModel {
    pub name: Option<String>,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_delete: FkAction,
    pub on_update: FkAction,
    pub deferrable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct IndexModel {
    pub name: Option<String>,
    /// What is indexed, as SQL: `email, created DESC`, or `btree (lower(email))` with a method.
    pub columns: String,
    pub unique: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TableModel {
    pub schema: String,
    pub name: String,
    pub comment: Option<String>,
    pub columns: Vec<ColumnModel>,
    pub primary_key: Option<KeyModel>,
    pub uniques: Vec<KeyModel>,
    pub checks: Vec<CheckModel>,
    pub foreign_keys: Vec<ForeignKeyModel>,
    pub indexes: Vec<IndexModel>,
}

/// Something DROP can remove.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DropObject {
    Relation {
        schema: String,
        name: String,
        object_type: ObjectType,
    },
    Sequence {
        schema: String,
        name: String,
    },
    /// Identity arguments as the catalog writes them, e.g. `qty integer`.
    Routine {
        schema: String,
        name: String,
        args: String,
        procedure: bool,
    },
    Index {
        schema: String,
        name: String,
    },
    Trigger {
        schema: String,
        table: String,
        name: String,
    },
    Schema {
        schema: String,
    },
}

/// Something that can be renamed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RenameObject {
    Relation {
        schema: String,
        name: String,
        object_type: ObjectType,
    },
    Column {
        schema: String,
        table: String,
        name: String,
    },
    Schema {
        schema: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct TableName {
    pub schema: String,
    pub name: String,
}

/// A change made through a form; the builder turns it into statements.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SchemaChange {
    CreateTable {
        table: TableModel,
    },
    /// `original` as loaded from the catalog, `table` as edited.
    AlterTable {
        original: Box<TableModel>,
        table: Box<TableModel>,
    },
    Drop {
        objects: Vec<DropObject>,
        if_exists: bool,
        cascade: bool,
    },
    Truncate {
        tables: Vec<TableName>,
        restart_identity: bool,
        cascade: bool,
    },
    Rename {
        object: RenameObject,
        new_name: String,
    },
}
