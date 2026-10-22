//! Decides whether a query result's rows can be edited, from the source table and column the
//! server reports for each output column (RowDescription), plus the catalog.

use quarry_db_core::{EditColumn, EditTarget, Editability};
use tokio_postgres::Client;

use crate::sqlutil::safe_type;

/// What the server said about one output column.
#[derive(Debug, Clone)]
pub struct Origin {
    pub table_oid: Option<u32>,
    pub column_id: Option<i16>,
    pub type_name: String,
}

const TABLE: &str = "
    SELECT n.nspname, c.relname, c.relkind::text, c.relpersistence::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.oid = $1";

const COLUMNS: &str = "
    SELECT a.attnum, a.attname,
           COALESCE(a.attnum = ANY (i.indkey), false) AS in_pk
    FROM pg_attribute a
    LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary
    WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum";

fn read_only(reason: impl Into<String>) -> Editability {
    Editability::ReadOnly {
        reason: reason.into(),
    }
}

pub async fn decide(
    client: &Client,
    origins: &[Origin],
) -> Result<Editability, tokio_postgres::Error> {
    let mut tables: Vec<u32> = origins
        .iter()
        .filter_map(|o| o.table_oid.filter(|&t| t != 0))
        .collect();
    tables.sort_unstable();
    tables.dedup();
    let oid = match tables.as_slice() {
        [] => return Ok(read_only("No column comes directly from a table.")),
        [one] => *one,
        many => {
            return Ok(read_only(format!(
                "Columns come from {} different tables.",
                many.len()
            )));
        }
    };

    let Some(t) = client.query_opt(TABLE, &[&oid]).await? else {
        return Ok(read_only("The source table no longer exists."));
    };
    let (schema, table, relkind, persistence): (String, String, String, String) =
        (t.get(0), t.get(1), t.get(2), t.get(3));
    if relkind != "r" && relkind != "p" {
        return Ok(read_only(format!(
            "\"{table}\" is not a table (views and other relations cannot be edited here)."
        )));
    }

    if persistence == "t" {
        // Edits are applied on a separate connection, which cannot see this session's temp tables.
        return Ok(read_only(format!(
            "\"{table}\" is a temporary table, visible only to this session."
        )));
    }

    let attrs: Vec<(i16, String, bool)> = client
        .query(COLUMNS, &[&oid])
        .await?
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    let pk: Vec<&(i16, String, bool)> = attrs.iter().filter(|a| a.2).collect();
    if pk.is_empty() {
        return Ok(read_only(format!(
            "\"{table}\" has no primary key, so rows cannot be identified safely."
        )));
    }

    // Map output columns to base columns; a base column shown twice is editable only once.
    let mut used: Vec<i16> = Vec::new();
    let columns: Vec<Option<EditColumn>> = origins
        .iter()
        .map(|o| {
            let att = o.column_id.filter(|_| o.table_oid == Some(oid))?;
            if used.contains(&att) || safe_type(&o.type_name).is_none() {
                return None;
            }
            used.push(att);
            let name = attrs.iter().find(|a| a.0 == att)?.1.clone();
            Some(EditColumn {
                name,
                type_name: o.type_name.clone(),
            })
        })
        .collect();

    let mut key = Vec::new();
    let mut missing = Vec::new();
    for (att, name, _) in &pk {
        match origins
            .iter()
            .position(|o| o.table_oid == Some(oid) && o.column_id == Some(*att))
        {
            Some(i) if columns[i].is_some() => key.push(i),
            _ => missing.push(name.clone()),
        }
    }
    if !missing.is_empty() {
        return Ok(read_only(format!(
            "Include the primary key ({}) in the query to edit rows.",
            missing.join(", ")
        )));
    }
    Ok(Editability::Editable {
        target: EditTarget {
            schema,
            table,
            columns,
            key,
        },
    })
}
