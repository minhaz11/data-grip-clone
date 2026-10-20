//! Lazy, engine-neutral metadata tree. Each [`MetaNode`] carries the [`MetadataRequest`] that loads
//! its children, so the UI never needs to know an engine's catalog layout.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectType {
    Table,
    View,
    MaterializedView,
}

/// How to load one level of the tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "level",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MetadataRequest {
    /// Top level of a data source: its schemas.
    Schemas,
    /// Object groups inside a schema ("Tables", "Views", ...), with counts.
    SchemaGroups {
        schema: String,
    },
    /// Objects of some types inside a schema.
    Objects {
        schema: String,
        types: Vec<ObjectType>,
    },
    /// Child groups of one object ("Columns", "Indexes").
    ObjectGroups {
        schema: String,
        name: String,
        object_type: ObjectType,
    },
    Columns {
        schema: String,
        table: String,
    },
    Indexes {
        schema: String,
        table: String,
    },
    /// Every table and view the user can see, flat, for completion. Nodes carry the schema in
    /// `detail` and `key = "schema.name"`.
    Relations,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MetaKind {
    Schema,
    Group,
    Table,
    View,
    MaterializedView,
    Column,
    Index,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaNode {
    /// Unique among siblings and stable across refreshes (used for expansion state).
    pub key: String,
    pub kind: MetaKind,
    pub name: String,
    /// Secondary text: column type, index definition, object comment.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// For groups: number of children, when cheap to know up front.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    /// Short flags such as "pk", "not null", "unique", "primary".
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub flags: Vec<String>,
    /// `None` for leaves.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<MetadataRequest>,
}

impl MetaNode {
    pub fn new(key: impl Into<String>, kind: MetaKind, name: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            kind,
            name: name.into(),
            detail: None,
            count: None,
            flags: Vec::new(),
            children: None,
        }
    }

    pub fn detail(mut self, detail: Option<String>) -> Self {
        self.detail = detail.filter(|d| !d.is_empty());
        self
    }

    pub fn count(mut self, count: u64) -> Self {
        self.count = Some(count);
        self
    }

    pub fn flag(mut self, on: bool, flag: &str) -> Self {
        if on {
            self.flags.push(flag.to_owned());
        }
        self
    }

    pub fn children(mut self, request: MetadataRequest) -> Self {
        self.children = Some(request);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_json_round_trips_with_ui_shape() {
        let r = MetadataRequest::ObjectGroups {
            schema: "public".into(),
            name: "orders".into(),
            object_type: ObjectType::Table,
        };
        let json = serde_json::to_value(&r).expect("encode");
        assert_eq!(
            json,
            serde_json::json!({"level": "objectGroups", "schema": "public", "name": "orders", "objectType": "table"})
        );
        assert_eq!(
            serde_json::from_value::<MetadataRequest>(json).expect("decode"),
            r
        );
        let schemas: MetadataRequest =
            serde_json::from_str(r#"{"level":"schemas"}"#).expect("decode");
        assert_eq!(schemas, MetadataRequest::Schemas);
    }

    #[test]
    fn leaf_nodes_omit_children_and_empty_fields() {
        let n = MetaNode::new("c:id", MetaKind::Column, "id").detail(Some(String::new()));
        let json = serde_json::to_value(&n).expect("encode");
        assert_eq!(
            json,
            serde_json::json!({"key": "c:id", "kind": "column", "name": "id"})
        );
    }
}
