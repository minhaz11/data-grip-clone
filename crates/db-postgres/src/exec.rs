//! Running one user statement. Values come back in the server's text form (exact for
//! numeric/int8/timestamps, works for every type).
//!
//! Queries (SELECT/VALUES/TABLE/WITH) run through a `SCROLL … WITH HOLD` cursor: PostgreSQL
//! materializes the result once, outside any transaction, so browsing holds no locks or snapshot
//! and any page can be read directly. Other statements run as they are, capped at `max_rows`.

use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::{TryStreamExt, pin_mut};
use quarry_db_core::{Cell, ColumnInfo, Editability, ExecOptions, StatementOutcome};

use crate::editability::{self, Origin};
use tokio_postgres::types::{Format, IsNull, ToSql, Type, to_sql_checked};
use tokio_postgres::{Client, SimpleQueryMessage};

/// A statement parameter sent in text format: the server parses it for whatever type it
/// inferred for `$n`, exactly as it would parse a literal, so any type works.
#[derive(Debug)]
pub struct TextParam<'a>(pub Option<&'a str>);

impl ToSql for TextParam<'_> {
    fn to_sql(
        &self,
        _ty: &Type,
        out: &mut bytes::BytesMut,
    ) -> Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match self.0 {
            Some(v) => {
                out.extend_from_slice(v.as_bytes());
                Ok(IsNull::No)
            }
            None => Ok(IsNull::Yes),
        }
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }

    fn encode_format(&self, _ty: &Type) -> Format {
        Format::Text
    }

    to_sql_checked!();
}

fn text_params(params: &[Cell]) -> Vec<TextParam<'_>> {
    params.iter().map(|p| TextParam(p.as_deref())).collect()
}

fn binds<'a>(params: &'a [TextParam<'a>]) -> Vec<&'a (dyn ToSql + Sync)> {
    params.iter().map(|p| p as &(dyn ToSql + Sync)).collect()
}

/// Open result cursors per session; the oldest is closed beyond this.
pub const MAX_OPEN_CURSORS: usize = 16;

/// Cursors this session created. Only these names are ever interpolated into SQL.
#[derive(Default)]
pub struct Cursors {
    next: AtomicU64,
    open: Mutex<VecDeque<String>>,
}

impl Cursors {
    fn allocate(&self) -> String {
        format!(
            "quarry_cursor_{}",
            self.next.fetch_add(1, Ordering::Relaxed)
        )
    }

    /// Registers `name`; returns a cursor to close if the cap was exceeded.
    fn register(&self, name: String) -> Option<String> {
        let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        open.push_back(name);
        (open.len() > MAX_OPEN_CURSORS)
            .then(|| open.pop_front())
            .flatten()
    }

    pub fn is_open(&self, name: &str) -> bool {
        self.open
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|c| c == name)
    }

    pub fn forget(&self, name: &str) -> bool {
        let mut open = self.open.lock().unwrap_or_else(|p| p.into_inner());
        let before = open.len();
        open.retain(|c| c != name);
        open.len() != before
    }
}

/// Whether a statement can be the body of `DECLARE … CURSOR`: it starts with SELECT, VALUES,
/// TABLE or WITH (after comments and opening parentheses).
pub fn cursor_eligible(sql: &str) -> bool {
    let mut rest = sql;
    loop {
        rest = rest.trim_start();
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map_or("", |(_, after)| after);
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map_or("", |(_, after)| after);
        } else if let Some(r) = rest.strip_prefix('(') {
            rest = r;
        } else {
            break;
        }
    }
    let word: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase();
    matches!(word.as_str(), "SELECT" | "VALUES" | "TABLE" | "WITH")
}

/// Errors raised while parsing/analysing, before anything ran: safe to retry without a cursor.
fn analysis_error(e: &tokio_postgres::Error) -> bool {
    e.code().is_some_and(|c| {
        let code = c.code();
        code.starts_with("42") || code.starts_with("0A")
    })
}

/// Runs one statement; with `params`, `$1…$n` are bound (extended protocol) instead of the
/// simple protocol.
pub async fn run(
    client: &Client,
    cursors: &Cursors,
    sql: &str,
    params: &[Cell],
    options: &ExecOptions,
) -> Result<StatementOutcome, tokio_postgres::Error> {
    // Describe-only prepare for column types. It executes nothing; statements that cannot be
    // prepared (utility commands, some DDL) simply get untyped columns.
    let origins: Option<Vec<Origin>> = client.prepare(sql).await.ok().map(|st| {
        st.columns()
            .iter()
            .map(|c| Origin {
                table_oid: c.table_oid(),
                column_id: c.column_id(),
                type_name: c.type_().name().to_owned(),
            })
            .collect()
    });
    let types: Option<Vec<String>> = origins
        .as_ref()
        .map(|o| o.iter().map(|c| c.type_name.clone()).collect());

    if cursor_eligible(sql) {
        let name = cursors.allocate();
        // `name` is generated here, never taken from callers; `sql` is the user's own statement.
        let declare = format!("DECLARE {name} SCROLL CURSOR WITH HOLD FOR {sql}");
        let declared = if params.is_empty() {
            client.batch_execute(&declare).await
        } else {
            let values = text_params(params);
            client.execute(&declare, &binds(&values)).await.map(|_| ())
        };
        match declared {
            Ok(()) => {
                if let Some(evicted) = cursors.register(name.clone()) {
                    let _ = client.batch_execute(&format!("CLOSE {evicted}")).await;
                }
                // A catalog lookup failure only makes the result read-only; the query succeeded.
                let edit = match &origins {
                    Some(o) => editability::decide(client, o).await.unwrap_or_else(|e| {
                        Editability::ReadOnly {
                            reason: format!("Could not inspect the source table: {e}"),
                        }
                    }),
                    None => Editability::ReadOnly {
                        reason: "The result could not be described.".into(),
                    },
                };
                return first_page(client, &name, types, Some(edit), options).await;
            }
            Err(e) if analysis_error(&e) => {} // e.g. data-modifying WITH, SELECT INTO: run directly
            Err(e) => return Err(e),
        }
    }
    if params.is_empty() {
        run_direct(client, sql, types, options).await
    } else {
        // Bound statements outside a cursor (INSERT … RETURNING, CALL) report their row count;
        // returned rows would arrive in binary form, which is not rendered as text here.
        let values = text_params(params);
        let rows_affected = client.execute(sql, &binds(&values)).await?;
        Ok(StatementOutcome::Command { rows_affected })
    }
}

/// Declares a cursor for `sql` with bound `params` (refined queries) and returns its first page,
/// labelled with the original result's `columns`.
pub async fn run_refined(
    client: &Client,
    cursors: &Cursors,
    sql: &str,
    params: &[String],
    columns: &[ColumnInfo],
    options: &ExecOptions,
) -> Result<StatementOutcome, tokio_postgres::Error> {
    let name = cursors.allocate();
    let binds: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = params
        .iter()
        .map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    client
        .execute(
            &format!("DECLARE {name} SCROLL CURSOR WITH HOLD FOR {sql}"),
            &binds,
        )
        .await?;
    if let Some(evicted) = cursors.register(name.clone()) {
        let _ = client.batch_execute(&format!("CLOSE {evicted}")).await;
    }
    let types: Vec<String> = columns
        .iter()
        .map(|c| c.type_name.clone().unwrap_or_default())
        .collect();
    match first_page(client, &name, Some(types), None, options).await? {
        // The wrapper renames outputs c1…cn; show the original names.
        StatementOutcome::Rows {
            rows,
            total_rows,
            truncated,
            cursor,
            ..
        } => Ok(StatementOutcome::Rows {
            columns: columns.to_vec(),
            rows,
            total_rows,
            truncated,
            cursor,
            // The UI keeps the editability decided for the original statement.
            edit: None,
        }),
        other => Ok(other),
    }
}

async fn first_page(
    client: &Client,
    name: &str,
    types: Option<Vec<String>>,
    edit: Option<Editability>,
    options: &ExecOptions,
) -> Result<StatementOutcome, tokio_postgres::Error> {
    // The cursor is materialized, so counting is cheap and exact.
    let mut total_rows = 0;
    for m in client
        .simple_query(&format!("MOVE FORWARD ALL FROM {name}"))
        .await?
    {
        if let SimpleQueryMessage::CommandComplete(n) = m {
            total_rows = n;
        }
    }
    let (columns, rows) = page(client, name, 0, options.max_rows, options.max_cell_chars).await?;
    let columns = columns
        .into_iter()
        .enumerate()
        .map(|(i, name)| ColumnInfo {
            name,
            type_name: types.as_ref().and_then(|t| t.get(i).cloned()),
        })
        .collect();
    let truncated = total_rows > rows.len() as u64;
    Ok(StatementOutcome::Rows {
        columns,
        rows,
        total_rows,
        truncated,
        cursor: Some(name.to_owned()),
        edit,
    })
}

/// Rows `[offset, offset + limit)` of cursor `name` and the column names.
pub async fn page(
    client: &Client,
    name: &str,
    offset: u64,
    limit: usize,
    max_cell_chars: usize,
) -> Result<(Vec<String>, Vec<Vec<Cell>>), tokio_postgres::Error> {
    // MOVE ABSOLUTE n leaves the cursor on row n; FETCH FORWARD then returns rows n+1…
    let sql = format!("MOVE ABSOLUTE {offset} FROM {name}; FETCH FORWARD {limit} FROM {name}");
    let stream = client.simple_query_raw(&sql).await?;
    pin_mut!(stream);
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    while let Some(m) = stream.try_next().await? {
        match m {
            SimpleQueryMessage::RowDescription(cols) => {
                columns = cols.iter().map(|c| c.name().to_owned()).collect()
            }
            SimpleQueryMessage::Row(row) => {
                rows.push(
                    (0..row.len())
                        .map(|i| row.get(i).map(|v| clip(v, max_cell_chars)))
                        .collect(),
                );
            }
            _ => {}
        }
    }
    Ok((columns, rows))
}

async fn run_direct(
    client: &Client,
    sql: &str,
    types: Option<Vec<String>>,
    options: &ExecOptions,
) -> Result<StatementOutcome, tokio_postgres::Error> {
    let stream = client.simple_query_raw(sql).await?;
    pin_mut!(stream);

    let mut columns: Option<Vec<ColumnInfo>> = None;
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut total_rows: u64 = 0;
    let mut rows_affected: u64 = 0;

    while let Some(message) = stream.try_next().await? {
        match message {
            SimpleQueryMessage::RowDescription(cols) => {
                columns = Some(
                    cols.iter()
                        .enumerate()
                        .map(|(i, c)| ColumnInfo {
                            name: c.name().to_owned(),
                            type_name: types.as_ref().and_then(|t| t.get(i).cloned()),
                        })
                        .collect(),
                );
            }
            SimpleQueryMessage::Row(row) => {
                total_rows += 1;
                // Rows past the cap are counted, not kept (no cursor to page through).
                if rows.len() < options.max_rows {
                    rows.push(
                        (0..row.len())
                            .map(|i| row.get(i).map(|v| clip(v, options.max_cell_chars)))
                            .collect(),
                    );
                }
            }
            SimpleQueryMessage::CommandComplete(n) => rows_affected = n,
            _ => {}
        }
    }

    Ok(match columns {
        Some(columns) => {
            let truncated = total_rows > rows.len() as u64;
            StatementOutcome::Rows {
                columns,
                rows,
                total_rows,
                truncated,
                cursor: None,
                edit: None,
            }
        }
        None => StatementOutcome::Command { rows_affected },
    })
}

/// Keeps at most `max` characters, marking the cut so the UI never shows a silently partial value.
fn clip(value: &str, max: usize) -> String {
    match value.char_indices().nth(max) {
        None => value.to_owned(),
        Some((cut, _)) => format!("{}… [{} chars]", &value[..cut], value.chars().count()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_marks_cut_values_and_respects_char_boundaries() {
        assert_eq!(clip("abc", 5), "abc");
        assert_eq!(clip("abcdef", 3), "abc… [6 chars]");
        assert_eq!(clip("ünïcødé", 2), "ün… [7 chars]");
    }

    #[test]
    fn cursor_eligibility_skips_comments_and_parens() {
        for yes in [
            "select 1",
            "  SELECT 1",
            "-- c\nselect 1",
            "/* c */ values (1)",
            "((select 1))",
            "table t",
            "with x as (select 1) select * from x",
        ] {
            assert!(cursor_eligible(yes), "{yes}");
        }
        for no in [
            "insert into t values (1)",
            "show search_path",
            "explain select 1",
            "-- only a comment",
            "",
            "selectx 1",
        ] {
            assert!(!cursor_eligible(no), "{no}");
        }
    }

    #[test]
    fn registry_caps_open_cursors_and_knows_its_own() {
        let c = Cursors::default();
        let names: Vec<String> = (0..=MAX_OPEN_CURSORS).map(|_| c.allocate()).collect();
        let mut evicted = None;
        for n in &names {
            evicted = c.register(n.clone()).or(evicted);
        }
        assert_eq!(
            evicted.as_deref(),
            Some(names[0].as_str()),
            "oldest evicted"
        );
        assert!(!c.is_open(&names[0]) && c.is_open(&names[1]));
        assert!(
            !c.is_open("pg_catalog; drop table x"),
            "foreign names are never accepted"
        );
        assert!(c.forget(&names[1]) && !c.forget(&names[1]));
    }
}
