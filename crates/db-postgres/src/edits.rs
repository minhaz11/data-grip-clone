//! Statements for applying row edits. Identifiers come from the catalog (via `EditTarget`) and are
//! always quoted; values are bind parameters cast to the column type.

use quarry_db_core::{ColumnValue, EditStatement, EditTarget, RowChange};

use crate::sqlutil::{quote_ident, safe_type};

pub const MAX_CHANGES: usize = 1_000;

fn column(t: &EditTarget, i: usize) -> Result<(&str, &str), String> {
    let c = t
        .columns
        .get(i)
        .and_then(Option::as_ref)
        .ok_or_else(|| format!("Column {} cannot be edited.", i + 1))?;
    let ty = safe_type(&c.type_name)
        .ok_or_else(|| format!("Column \"{}\" has an unsupported type.", c.name))?;
    Ok((&c.name, ty))
}

struct Builder {
    params: Vec<Option<String>>,
}

impl Builder {
    fn bind(&mut self, value: Option<String>, ty: &str) -> String {
        self.params.push(value);
        format!("(${}::text)::{ty}", self.params.len())
    }

    fn key_condition(&mut self, t: &EditTarget, key: &[Option<String>]) -> Result<String, String> {
        if key.len() != t.key.len() {
            return Err("The row's primary key is incomplete.".into());
        }
        let mut parts = Vec::new();
        for (&col, value) in t.key.iter().zip(key) {
            let (name, ty) = column(t, col)?;
            let v = value.clone().ok_or("A primary key value is NULL.")?;
            parts.push(format!(
                "{} = {}",
                quote_ident(name),
                self.bind(Some(v), ty)
            ));
        }
        Ok(parts.join(" AND "))
    }
}

fn distinct_columns(values: &[ColumnValue]) -> Result<(), String> {
    let mut seen = Vec::new();
    for v in values {
        if seen.contains(&v.column) {
            return Err(format!("Column {} is set twice.", v.column + 1));
        }
        seen.push(v.column);
    }
    Ok(())
}

pub fn build(t: &EditTarget, changes: &[RowChange]) -> Result<Vec<EditStatement>, String> {
    if changes.is_empty() {
        return Err("No changes to apply.".into());
    }
    if changes.len() > MAX_CHANGES {
        return Err(format!("At most {MAX_CHANGES} changes per submit."));
    }
    let relation = format!("{}.{}", quote_ident(&t.schema), quote_ident(&t.table));
    changes
        .iter()
        .map(|change| {
            let mut b = Builder { params: Vec::new() };
            let sql = match change {
                RowChange::Update { key, set, original } => {
                    if set.is_empty() {
                        return Err("An update without changes.".into());
                    }
                    distinct_columns(set)?;
                    let mut assignments = Vec::new();
                    for v in set {
                        let (name, ty) = column(t, v.column)?;
                        assignments.push(format!(
                            "{} = {}",
                            quote_ident(name),
                            b.bind(v.value.clone(), ty)
                        ));
                    }
                    let mut condition = b.key_condition(t, key)?;
                    // Optimistic lock: only update if what was read is still there.
                    for o in original {
                        let (name, ty) = column(t, o.column)?;
                        let bound = b.bind(o.value.clone(), ty);
                        condition.push_str(&format!(
                            " AND {} IS NOT DISTINCT FROM {bound}",
                            quote_ident(name)
                        ));
                    }
                    format!(
                        "UPDATE {relation} SET {} WHERE {condition}",
                        assignments.join(", ")
                    )
                }
                RowChange::Delete { key } => {
                    let condition = b.key_condition(t, key)?;
                    format!("DELETE FROM {relation} WHERE {condition}")
                }
                RowChange::Insert { values } => {
                    distinct_columns(values)?;
                    if values.is_empty() {
                        format!("INSERT INTO {relation} DEFAULT VALUES")
                    } else {
                        let mut names = Vec::new();
                        let mut binds = Vec::new();
                        for v in values {
                            let (name, ty) = column(t, v.column)?;
                            names.push(quote_ident(name));
                            binds.push(b.bind(v.value.clone(), ty));
                        }
                        format!(
                            "INSERT INTO {relation} ({}) VALUES ({})",
                            names.join(", "),
                            binds.join(", ")
                        )
                    }
                }
            };
            Ok(EditStatement {
                sql,
                params: b.params,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use quarry_db_core::EditColumn;

    fn target() -> EditTarget {
        let c = |n: &str, t: &str| {
            Some(EditColumn {
                name: n.into(),
                type_name: t.into(),
            })
        };
        EditTarget {
            schema: "shop".into(),
            table: "Line \"Items\"".into(),
            columns: vec![c("id", "int4"), c("note", "text"), None, c("qty", "int4")],
            key: vec![0],
        }
    }
    fn v(column: usize, value: Option<&str>) -> ColumnValue {
        ColumnValue {
            column,
            value: value.map(str::to_owned),
        }
    }
    fn s(x: &str) -> Option<String> {
        Some(x.to_owned())
    }

    #[test]
    fn update_binds_values_checks_key_and_originals() {
        let out = build(
            &target(),
            &[RowChange::Update {
                key: vec![s("7")],
                set: vec![v(1, Some("new")), v(3, None)],
                original: vec![v(1, Some("old")), v(3, Some("2"))],
            }],
        )
        .expect("build");
        assert_eq!(
            out[0].sql,
            "UPDATE \"shop\".\"Line \"\"Items\"\"\" SET \"note\" = ($1::text)::text, \"qty\" = ($2::text)::int4 \
             WHERE \"id\" = ($3::text)::int4 AND \"note\" IS NOT DISTINCT FROM ($4::text)::text \
             AND \"qty\" IS NOT DISTINCT FROM ($5::text)::int4"
        );
        assert_eq!(out[0].params, [s("new"), None, s("7"), s("old"), s("2")]);
    }

    #[test]
    fn delete_and_insert() {
        let out = build(
            &target(),
            &[
                RowChange::Delete { key: vec![s("3")] },
                RowChange::Insert {
                    values: vec![v(1, Some("x"))],
                },
                RowChange::Insert { values: vec![] },
            ],
        )
        .expect("build");
        assert_eq!(
            out[0].sql,
            "DELETE FROM \"shop\".\"Line \"\"Items\"\"\" WHERE \"id\" = ($1::text)::int4"
        );
        assert_eq!(
            out[1].sql,
            "INSERT INTO \"shop\".\"Line \"\"Items\"\"\" (\"note\") VALUES (($1::text)::text)"
        );
        assert_eq!(
            out[2].sql,
            "INSERT INTO \"shop\".\"Line \"\"Items\"\"\" DEFAULT VALUES"
        );
    }

    #[test]
    fn values_never_enter_sql_text() {
        let attack = "'); drop table x; --";
        let out = build(
            &target(),
            &[RowChange::Update {
                key: vec![s("1")],
                set: vec![v(1, Some(attack))],
                original: vec![],
            }],
        )
        .expect("build");
        assert!(!out[0].sql.contains("drop"));
        assert_eq!(out[0].params[0].as_deref(), Some(attack));
    }

    #[test]
    fn rejects_unsafe_changes() {
        let t = target();
        let err = |c: RowChange| build(&t, &[c]).expect_err("invalid");
        assert!(
            err(RowChange::Update {
                key: vec![s("1")],
                set: vec![v(2, Some("x"))],
                original: vec![]
            })
            .contains("cannot be edited")
        );
        assert!(
            err(RowChange::Update {
                key: vec![],
                set: vec![v(1, Some("x"))],
                original: vec![]
            })
            .contains("incomplete")
        );
        assert!(err(RowChange::Delete { key: vec![None] }).contains("NULL"));
        assert!(
            err(RowChange::Update {
                key: vec![s("1")],
                set: vec![],
                original: vec![]
            })
            .contains("without changes")
        );
        assert!(
            err(RowChange::Insert {
                values: vec![v(1, Some("a")), v(1, Some("b"))]
            })
            .contains("twice")
        );
        assert!(build(&t, &[]).is_err());
        let mut bad_type = target();
        bad_type.columns[1] = Some(EditColumn {
            name: "note".into(),
            type_name: "text); drop".into(),
        });
        assert!(
            build(
                &bad_type,
                &[RowChange::Insert {
                    values: vec![v(1, Some("x"))]
                }]
            )
            .expect_err("type")
            .contains("unsupported type")
        );
    }
}
