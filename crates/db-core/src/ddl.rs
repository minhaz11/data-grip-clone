//! DDL generation requests (M4.4): what to generate and how.

use serde::{Deserialize, Serialize};

/// An object to generate DDL for. Names are exact (not quoted).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DdlObject {
    /// A table, view or materialized view, with its indexes, keys, triggers and comments.
    Relation {
        schema: String,
        name: String,
    },
    Sequence {
        schema: String,
        name: String,
    },
    /// A function or procedure, told apart from overloads by its identity arguments.
    Routine {
        schema: String,
        name: String,
        args: String,
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
    /// The schema and everything in it, in an order that applies cleanly.
    Schema {
        schema: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct DdlOptions {
    /// Schema-qualify every name (otherwise names in the object's own schema are bare).
    pub qualify: bool,
    /// Add `ALTER … OWNER TO`.
    pub owner: bool,
    /// Add `GRANT` statements from the object's privileges.
    pub grants: bool,
}

impl Default for DdlOptions {
    fn default() -> Self {
        Self {
            qualify: true,
            owner: false,
            grants: false,
        }
    }
}
