//! Running one user statement over the simple-query protocol, which returns every value in the
//! server's text form (exact for numeric/int8/timestamps, and works for every type).

use futures_util::{TryStreamExt, pin_mut};
use quarry_db_core::{Cell, ColumnInfo, ExecOptions, StatementOutcome};
use tokio_postgres::{Client, SimpleQueryMessage};

pub async fn run(
    client: &Client,
    sql: &str,
    options: &ExecOptions,
) -> Result<StatementOutcome, tokio_postgres::Error> {
    // Describe-only prepare for column types. It executes nothing; statements that cannot be
    // prepared (utility commands, some DDL) simply get untyped columns.
    let types: Option<Vec<String>> = client.prepare(sql).await.ok().map(|st| {
        st.columns()
            .iter()
            .map(|c| c.type_().name().to_owned())
            .collect()
    });

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
                // Rows past the display cap are counted, not kept.
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
    use super::clip;

    #[test]
    fn clip_marks_cut_values_and_respects_char_boundaries() {
        assert_eq!(clip("abc", 5), "abc");
        assert_eq!(clip("abcdef", 3), "abc… [6 chars]");
        assert_eq!(clip("ünïcødé", 2), "ün… [7 chars]");
    }
}
