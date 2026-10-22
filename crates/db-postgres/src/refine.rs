//! SQL for server-side sort/filter of a query result. The original query is wrapped as
//! `SELECT * FROM (<query>) AS q(c1, …, cn)`: the column alias list renames outputs by position,
//! so duplicate or odd column names never need quoting. Every identifier in the generated text is
//! produced here; comparison values are bind parameters.

use quarry_db_core::{ColumnInfo, Filter, FilterOp, Refinement};

pub const MAX_FILTERS: usize = 20;
pub const MAX_SORT_KEYS: usize = 10;
pub const MAX_VALUE_CHARS: usize = 10_000;

#[derive(Debug, PartialEq, Eq)]
pub struct Built {
    pub sql: String,
    pub params: Vec<String>,
}

/// A PostgreSQL type name safe to place in a cast (`int4`, `timestamptz`, `_text`, …).
fn safe_type(name: &str) -> Option<&str> {
    let ok = !name.is_empty()
        && name.len() <= 63
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    ok.then_some(name)
}

/// Escapes LIKE wildcards so user text matches literally (with `ESCAPE '\'`).
fn like_literal(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub fn build(base: &str, columns: &[ColumnInfo], r: &Refinement) -> Result<Built, String> {
    let n = columns.len();
    if n == 0 {
        return Err("This result has no columns to sort or filter.".into());
    }
    if r.filters.len() > MAX_FILTERS {
        return Err(format!("At most {MAX_FILTERS} filters."));
    }
    if r.sort.len() > MAX_SORT_KEYS {
        return Err(format!("At most {MAX_SORT_KEYS} sort columns."));
    }

    let mut params = Vec::new();
    let mut conditions = Vec::new();
    for Filter { column, op, value } in &r.filters {
        let col = columns
            .get(*column)
            .ok_or_else(|| format!("Unknown column {}.", column + 1))?;
        let c = format!("q.c{}", column + 1);
        let value = match (op.takes_value(), value) {
            (true, Some(v)) if v.chars().count() <= MAX_VALUE_CHARS => Some(v),
            (true, Some(_)) => {
                return Err(format!(
                    "Filter values are limited to {MAX_VALUE_CHARS} characters."
                ));
            }
            (true, None) => return Err(format!("The filter on \"{}\" needs a value.", col.name)),
            (false, _) => None,
        };
        let mut bind = |v: String| {
            params.push(v);
            format!("${}::text", params.len())
        };
        let typed = |p: String| match col.type_name.as_deref().and_then(safe_type) {
            Some(t) => (c.clone(), format!("({p})::{t}")),
            None => (format!("{c}::text"), p), // untyped: compare text forms
        };
        let cond = match (op, value) {
            (FilterOp::IsNull, _) => format!("{c} IS NULL"),
            (FilterOp::NotNull, _) => format!("{c} IS NOT NULL"),
            (FilterOp::Contains, Some(v)) => format!(
                "{c}::text ILIKE {} ESCAPE '\\'",
                bind(format!("%{}%", like_literal(v)))
            ),
            (FilterOp::StartsWith, Some(v)) => format!(
                "{c}::text ILIKE {} ESCAPE '\\'",
                bind(format!("{}%", like_literal(v)))
            ),
            (cmp, Some(v)) => {
                let sym = match cmp {
                    FilterOp::Eq => "=",
                    FilterOp::Ne => "<>",
                    FilterOp::Lt => "<",
                    FilterOp::Le => "<=",
                    FilterOp::Gt => ">",
                    FilterOp::Ge => ">=",
                    _ => unreachable!("handled above"),
                };
                let (lhs, rhs) = typed(bind(v.clone()));
                format!("{lhs} {sym} {rhs}")
            }
            (_, None) => unreachable!("value presence checked above"),
        };
        conditions.push(cond);
    }

    let mut seen = Vec::new();
    let mut order = Vec::new();
    for k in &r.sort {
        if k.column >= n {
            return Err(format!("Unknown column {}.", k.column + 1));
        }
        if seen.contains(&k.column) {
            continue;
        }
        seen.push(k.column);
        order.push(format!(
            "{}{}",
            k.column + 1,
            if k.descending { " DESC" } else { "" }
        ));
    }

    let aliases: Vec<String> = (1..=n).map(|i| format!("c{i}")).collect();
    // The original query sits on its own lines so a trailing `-- comment` cannot swallow `)`.
    let mut sql = format!("SELECT * FROM (\n{base}\n) AS q({})", aliases.join(", "));
    if !conditions.is_empty() {
        sql.push_str("\nWHERE ");
        sql.push_str(&conditions.join("\n  AND "));
    }
    if !order.is_empty() {
        sql.push_str("\nORDER BY ");
        sql.push_str(&order.join(", "));
    }
    Ok(Built { sql, params })
}

#[cfg(test)]
mod tests {
    use super::*;
    use quarry_db_core::SortKey;

    fn cols() -> Vec<ColumnInfo> {
        vec![
            ColumnInfo {
                name: "id".into(),
                type_name: Some("int4".into()),
            },
            ColumnInfo {
                name: "email".into(),
                type_name: Some("text".into()),
            },
            ColumnInfo {
                name: "odd".into(),
                type_name: None,
            },
            ColumnInfo {
                name: "evil".into(),
                type_name: Some("int4; drop table x".into()),
            },
        ]
    }

    fn f(column: usize, op: FilterOp, value: Option<&str>) -> Filter {
        Filter {
            column,
            op,
            value: value.map(str::to_owned),
        }
    }

    #[test]
    fn wraps_with_positional_aliases_binds_values_and_sorts_by_position() {
        let r = Refinement {
            sort: vec![
                SortKey {
                    column: 1,
                    descending: true,
                },
                SortKey {
                    column: 0,
                    descending: false,
                },
            ],
            filters: vec![
                f(0, FilterOp::Ge, Some("10")),
                f(1, FilterOp::Contains, Some("50%_off\\")),
                f(2, FilterOp::IsNull, None),
            ],
        };
        let b = build("select id, email, odd -- trailing comment", &cols(), &r).expect("build");
        assert_eq!(
            b.sql,
            "SELECT * FROM (\nselect id, email, odd -- trailing comment\n) AS q(c1, c2, c3, c4)\n\
             WHERE q.c1 >= ($1::text)::int4\n  AND q.c2::text ILIKE $2::text ESCAPE '\\'\n  AND q.c3 IS NULL\n\
             ORDER BY 2 DESC, 1"
        );
        assert_eq!(b.params, ["10", "%50\\%\\_off\\\\%"]);
    }

    #[test]
    fn untyped_and_unsafe_type_names_compare_as_text() {
        let r = Refinement {
            sort: vec![],
            filters: vec![f(2, FilterOp::Eq, Some("x")), f(3, FilterOp::Lt, Some("5"))],
        };
        let b = build("select 1", &cols(), &r).expect("build");
        assert!(b.sql.contains("q.c3::text = $1::text"), "{}", b.sql);
        assert!(
            b.sql.contains("q.c4::text < $2::text"),
            "unsafe type name never reaches SQL: {}",
            b.sql
        );
        assert!(!b.sql.contains("drop table"));
    }

    #[test]
    fn values_never_appear_in_sql_text() {
        let attack = "'); drop table shop.customers; --";
        let r = Refinement {
            sort: vec![],
            filters: vec![
                f(1, FilterOp::Eq, Some(attack)),
                f(1, FilterOp::StartsWith, Some(attack)),
            ],
        };
        let b = build("select 1", &cols(), &r).expect("build");
        assert!(!b.sql.contains("drop"), "{}", b.sql);
        assert_eq!(b.params[0], attack);
    }

    #[test]
    fn rejects_bad_input() {
        let c = cols();
        let bad = |r: Refinement| build("select 1", &c, &r).expect_err("invalid");
        assert!(
            bad(Refinement {
                sort: vec![SortKey {
                    column: 9,
                    descending: false
                }],
                filters: vec![]
            })
            .contains("Unknown column")
        );
        assert!(
            bad(Refinement {
                sort: vec![],
                filters: vec![f(0, FilterOp::Eq, None)]
            })
            .contains("needs a value")
        );
        assert!(
            bad(Refinement {
                sort: vec![],
                filters: vec![f(1, FilterOp::Eq, Some(&"x".repeat(MAX_VALUE_CHARS + 1)))]
            })
            .contains("limited")
        );
        assert!(
            bad(Refinement {
                sort: vec![],
                filters: (0..=MAX_FILTERS)
                    .map(|_| f(0, FilterOp::NotNull, None))
                    .collect()
            })
            .contains("At most")
        );
        assert!(build("select 1", &[], &Refinement::default()).is_err());
    }

    #[test]
    fn duplicate_sort_keys_keep_the_first() {
        let r = Refinement {
            sort: vec![
                SortKey {
                    column: 0,
                    descending: true,
                },
                SortKey {
                    column: 0,
                    descending: false,
                },
            ],
            filters: vec![],
        };
        assert!(
            build("select 1", &cols(), &r)
                .expect("build")
                .sql
                .ends_with("ORDER BY 1 DESC")
        );
    }

    #[test]
    fn type_name_allowlist() {
        for ok in ["int4", "timestamptz", "_text", "varchar"] {
            assert!(safe_type(ok).is_some(), "{ok}");
        }
        for bad in ["", "Int4", "int4)", "a b", "x;y", "\"q\""] {
            assert!(safe_type(bad).is_none(), "{bad}");
        }
    }
}
