//! Query history (M5.1, ADR-0004): every statement run against a data source, newest first, with
//! full-text search over the statement text. Statements hold literals, so a data source can turn
//! recording off; redaction is planned for later.

use quarry_db_core::TxMode;
use rusqlite::{OptionalExtension, Row, params, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum HistoryStatus {
    Ok,
    Error,
    Cancelled,
}

impl HistoryStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(s: &str) -> Result<Self, StoreError> {
        match s {
            "ok" => Ok(Self::Ok),
            "error" => Ok(Self::Error),
            "cancelled" => Ok(Self::Cancelled),
            other => Err(StoreError::Invalid(format!(
                "unknown HistoryStatus '{other}'"
            ))),
        }
    }
}

/// One statement to record, as the query job saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryRecord {
    /// The console's own session, if the statement ran in one.
    pub console: Option<String>,
    pub sql: String,
    /// Unix time in milliseconds.
    pub started_at: i64,
    pub duration_ms: u64,
    pub status: HistoryStatus,
    /// Rows returned or affected; absent for failures.
    pub row_count: Option<u64>,
    /// First line of the error message for failures and cancels.
    pub error: Option<String>,
    pub tx_mode: TxMode,
}

/// A recorded statement, as the history popup shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub connection_id: String,
    pub console: Option<String>,
    pub sql: String,
    /// Unix time in milliseconds.
    pub started_at: i64,
    pub duration_ms: u64,
    pub status: HistoryStatus,
    pub row_count: Option<u64>,
    pub error: Option<String>,
    pub tx_mode: TxMode,
}

/// A search: every word of `text` must match (as a prefix) somewhere in the statement.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    /// Only this data source's entries; absent for all of them.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub connection_id: Option<String>,
    #[serde(default)]
    pub text: String,
    pub limit: u32,
    #[serde(default)]
    pub offset: u32,
}

/// How much history to keep per data source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Retention {
    pub max_entries: u32,
    /// Entries older than this many days are removed; 0 keeps them regardless of age.
    pub max_age_days: u32,
}

/// The longest error summary kept per entry, in characters.
pub const ERROR_SUMMARY_MAX: usize = 500;
const DAY_MS: i64 = 86_400_000;

/// The first line of an error message, shortened to [`ERROR_SUMMARY_MAX`] characters.
pub fn error_summary(message: &str) -> String {
    let line = message.lines().next().unwrap_or("").trim();
    line.chars().take(ERROR_SUMMARY_MAX).collect()
}

/// An FTS5 query for `text`: each word becomes a quoted prefix phrase, so input is never parsed as
/// FTS syntax. Words without letters or digits match nothing in the index and are dropped.
fn match_expression(text: &str) -> Option<String> {
    let terms: Vec<String> = text
        .split_whitespace()
        .filter(|word| word.chars().any(char::is_alphanumeric))
        .map(|word| format!("\"{}\"*", word.replace('"', "\"\"")))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

fn tx_mode_text(mode: TxMode) -> &'static str {
    match mode {
        TxMode::Auto => "auto",
        TxMode::Manual => "manual",
    }
}

fn parse_tx_mode(s: &str) -> Result<TxMode, StoreError> {
    match s {
        "auto" => Ok(TxMode::Auto),
        "manual" => Ok(TxMode::Manual),
        other => Err(StoreError::Invalid(format!("unknown TxMode '{other}'"))),
    }
}

// SQLite integers are signed; counts and durations never come near the limits.
fn signed(n: u64) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

fn unsigned(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

const COLUMNS: &str =
    "id, connection_id, console, sql, started_at, duration_ms, status, row_count, error, tx_mode";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Result<HistoryEntry, StoreError>> {
    let parsed = (|| -> Result<HistoryEntry, StoreError> {
        Ok(HistoryEntry {
            id: row.get(0)?,
            connection_id: row.get(1)?,
            console: row.get(2)?,
            sql: row.get(3)?,
            started_at: row.get(4)?,
            duration_ms: unsigned(row.get(5)?),
            status: HistoryStatus::parse(&row.get::<_, String>(6)?)?,
            row_count: row.get::<_, Option<i64>>(7)?.map(unsigned),
            error: row.get(8)?,
            tx_mode: parse_tx_mode(&row.get::<_, String>(9)?)?,
        })
    })();
    Ok(parsed)
}

impl Store {
    /// Records a job's statements for `connection_id` and prunes to `retention`, in one
    /// transaction. Writes nothing when the data source has history turned off or no longer
    /// exists. Returns the number of entries written.
    pub fn record_history(
        &self,
        connection_id: &str,
        records: &[HistoryRecord],
        retention: Retention,
        now_ms: i64,
    ) -> Result<usize, StoreError> {
        if records.is_empty() {
            return Ok(0);
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let enabled: Option<bool> = tx
            .query_row(
                "SELECT history_enabled FROM connections WHERE id = ?1",
                [connection_id],
                |row| row.get(0),
            )
            .optional()?;
        if enabled != Some(true) {
            return Ok(0);
        }
        {
            let mut insert = tx.prepare_cached(
                "INSERT INTO query_history (connection_id, console, sql, started_at, duration_ms,
                     status, row_count, error, tx_mode)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for r in records {
                insert.execute(params![
                    connection_id,
                    r.console,
                    r.sql,
                    r.started_at,
                    signed(r.duration_ms),
                    r.status.as_str(),
                    r.row_count.map(signed),
                    r.error,
                    tx_mode_text(r.tx_mode),
                ])?;
            }
        }
        prune(&tx, Some(connection_id), retention, now_ms)?;
        tx.commit()?;
        Ok(records.len())
    }

    /// Applies `retention` to every data source's history (after the settings change).
    pub fn prune_history(&self, retention: Retention, now_ms: i64) -> Result<usize, StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let removed = prune(&tx, None, retention, now_ms)?;
        tx.commit()?;
        Ok(removed)
    }

    /// Entries matching `query`, newest first.
    pub fn search_history(&self, query: &HistoryQuery) -> Result<Vec<HistoryEntry>, StoreError> {
        let mut sql = format!("SELECT {COLUMNS} FROM query_history WHERE 1 = 1");
        let mut values: Vec<Value> = Vec::new();
        if let Some(connection_id) = &query.connection_id {
            values.push(Value::Text(connection_id.clone()));
            sql.push_str(&format!(" AND connection_id = ?{}", values.len()));
        }
        if let Some(expression) = match_expression(&query.text) {
            values.push(Value::Text(expression));
            sql.push_str(&format!(
                " AND id IN (SELECT rowid FROM query_history_fts WHERE query_history_fts MATCH ?{})",
                values.len()
            ));
        }
        values.push(Value::Integer(i64::from(query.limit)));
        values.push(Value::Integer(i64::from(query.offset)));
        sql.push_str(&format!(
            " ORDER BY id DESC LIMIT ?{} OFFSET ?{}",
            values.len() - 1,
            values.len()
        ));
        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values), from_row)?;
        rows.map(|r| r?).collect()
    }

    /// Removes the given entries; returns how many existed.
    pub fn delete_history(&self, ids: &[i64]) -> Result<usize, StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let mut removed = 0;
        {
            let mut delete = tx.prepare_cached("DELETE FROM query_history WHERE id = ?1")?;
            for id in ids {
                removed += delete.execute([id])?;
            }
        }
        tx.commit()?;
        Ok(removed)
    }

    /// Removes every entry of one data source; returns how many there were.
    pub fn clear_history(&self, connection_id: &str) -> Result<usize, StoreError> {
        Ok(self.conn().execute(
            "DELETE FROM query_history WHERE connection_id = ?1",
            [connection_id],
        )?)
    }
}

/// Deletes entries beyond the newest `max_entries` per data source and those older than the age
/// limit. `connection_id` limits it to one data source.
fn prune(
    tx: &rusqlite::Transaction<'_>,
    connection_id: Option<&str>,
    retention: Retention,
    now_ms: i64,
) -> Result<usize, StoreError> {
    let ids: Vec<String> = match connection_id {
        Some(id) => vec![id.to_owned()],
        None => {
            let mut stmt = tx.prepare("SELECT DISTINCT connection_id FROM query_history")?;
            stmt.query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()?
        }
    };
    let mut removed = 0;
    for id in &ids {
        // Ids grow with time, so everything at or below the first one past the limit is older.
        removed += tx.execute(
            "DELETE FROM query_history WHERE connection_id = ?1 AND id <= (
                 SELECT id FROM query_history WHERE connection_id = ?1
                 ORDER BY id DESC LIMIT 1 OFFSET ?2)",
            params![id, retention.max_entries],
        )?;
        if retention.max_age_days > 0 {
            let cutoff = now_ms - i64::from(retention.max_age_days) * DAY_MS;
            removed += tx.execute(
                "DELETE FROM query_history WHERE connection_id = ?1 AND started_at < ?2",
                params![id, cutoff],
            )?;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::tests::draft;
    use std::time::Instant;

    const NOW: i64 = 1_800_000_000_000;
    const KEEP_ALL: Retention = Retention {
        max_entries: 1_000_000,
        max_age_days: 0,
    };

    fn record(sql: &str, status: HistoryStatus) -> HistoryRecord {
        HistoryRecord {
            console: None,
            sql: sql.into(),
            started_at: NOW,
            duration_ms: 3,
            status,
            row_count: (status == HistoryStatus::Ok).then_some(1),
            error: (status != HistoryStatus::Ok).then(|| "boom".into()),
            tx_mode: TxMode::Auto,
        }
    }

    fn store_with(ids: &[&str]) -> Store {
        let store = Store::open_in_memory().expect("open");
        for id in ids {
            store
                .insert_connection(id, draft(&format!("db {id}")))
                .expect("insert");
        }
        store
    }

    fn search(store: &Store, connection_id: Option<&str>, text: &str) -> Vec<HistoryEntry> {
        store
            .search_history(&HistoryQuery {
                connection_id: connection_id.map(str::to_owned),
                text: text.into(),
                limit: 100,
                offset: 0,
            })
            .expect("search")
    }

    fn count(store: &Store) -> i64 {
        store
            .conn()
            .query_row("SELECT count(*) FROM query_history", [], |row| row.get(0))
            .expect("count")
    }

    #[test]
    fn bundled_sqlite_has_fts5() {
        let store = Store::open_in_memory().expect("open");
        let enabled: bool = store
            .conn()
            .query_row(
                "SELECT sqlite_compileoption_used('ENABLE_FTS5')",
                [],
                |row| row.get(0),
            )
            .expect("compile option");
        assert!(enabled);
    }

    #[test]
    fn records_and_lists_newest_first_with_every_field() {
        let store = store_with(&["a"]);
        let written = store
            .record_history(
                "a",
                &[
                    record("select 1", HistoryStatus::Ok),
                    HistoryRecord {
                        console: Some("console_1".into()),
                        tx_mode: TxMode::Manual,
                        ..record("select nope", HistoryStatus::Error)
                    },
                    record("select pg_sleep(10)", HistoryStatus::Cancelled),
                ],
                KEEP_ALL,
                NOW,
            )
            .expect("record");
        assert_eq!(written, 3);
        let entries = search(&store, Some("a"), "");
        let statuses: Vec<HistoryStatus> = entries.iter().map(|e| e.status).collect();
        assert_eq!(
            statuses,
            [
                HistoryStatus::Cancelled,
                HistoryStatus::Error,
                HistoryStatus::Ok
            ]
        );
        let failed = &entries[1];
        assert_eq!(failed.console.as_deref(), Some("console_1"));
        assert_eq!(failed.tx_mode, TxMode::Manual);
        assert_eq!(failed.error.as_deref(), Some("boom"));
        assert_eq!(failed.row_count, None);
        assert_eq!(entries[2].row_count, Some(1));
        assert_eq!(entries[2].started_at, NOW);
    }

    #[test]
    fn disabled_data_source_writes_nothing() {
        let store = store_with(&["a"]);
        store
            .update_connection(
                "a",
                crate::ConnectionDraft {
                    history_enabled: false,
                    ..draft("db a")
                },
            )
            .expect("disable");
        let written = store
            .record_history("a", &[record("select 1", HistoryStatus::Ok)], KEEP_ALL, NOW)
            .expect("record");
        assert_eq!(written, 0);
        assert_eq!(count(&store), 0);
        // Unknown data sources (deleted while a job ran) are skipped too.
        let written = store
            .record_history(
                "gone",
                &[record("select 1", HistoryStatus::Ok)],
                KEEP_ALL,
                NOW,
            )
            .expect("record");
        assert_eq!(written, 0);
        assert_eq!(count(&store), 0);
    }

    #[test]
    fn retention_prunes_oldest_first_at_the_limit() {
        let store = store_with(&["a", "b"]);
        let limit = Retention {
            max_entries: 3,
            max_age_days: 0,
        };
        for n in 0..5 {
            store
                .record_history(
                    "a",
                    &[record(&format!("select {n}"), HistoryStatus::Ok)],
                    limit,
                    NOW,
                )
                .expect("record");
        }
        store
            .record_history("b", &[record("select b", HistoryStatus::Ok)], limit, NOW)
            .expect("record");
        let kept: Vec<String> = search(&store, Some("a"), "")
            .into_iter()
            .map(|e| e.sql)
            .collect();
        assert_eq!(kept, ["select 4", "select 3", "select 2"]);
        assert_eq!(search(&store, Some("b"), "").len(), 1);
    }

    #[test]
    fn retention_drops_entries_past_the_age_limit() {
        let store = store_with(&["a"]);
        let old = HistoryRecord {
            started_at: NOW - 10 * DAY_MS,
            ..record("select old", HistoryStatus::Ok)
        };
        store
            .record_history(
                "a",
                &[old, record("select new", HistoryStatus::Ok)],
                KEEP_ALL,
                NOW,
            )
            .expect("record");
        assert_eq!(count(&store), 2);
        let removed = store
            .prune_history(
                Retention {
                    max_entries: 100,
                    max_age_days: 7,
                },
                NOW,
            )
            .expect("prune");
        assert_eq!(removed, 1);
        let kept: Vec<String> = search(&store, None, "")
            .into_iter()
            .map(|e| e.sql)
            .collect();
        assert_eq!(kept, ["select new"]);
    }

    #[test]
    fn full_text_search_finds_by_table_name_and_keyword() {
        let store = store_with(&["a", "b"]);
        store
            .record_history(
                "a",
                &[
                    record(
                        "SELECT * FROM shop.order_items WHERE id = 1",
                        HistoryStatus::Ok,
                    ),
                    record("UPDATE customers SET name = 'x'", HistoryStatus::Ok),
                    record("delete from orders", HistoryStatus::Error),
                ],
                KEEP_ALL,
                NOW,
            )
            .expect("record");
        store
            .record_history(
                "b",
                &[record("select * from orders", HistoryStatus::Ok)],
                KEEP_ALL,
                NOW,
            )
            .expect("record");

        let sql = |entries: Vec<HistoryEntry>| -> Vec<String> {
            entries.into_iter().map(|e| e.sql).collect()
        };
        assert_eq!(
            sql(search(&store, Some("a"), "order_items")),
            ["SELECT * FROM shop.order_items WHERE id = 1"]
        );
        // Prefix and case-insensitive keyword matches.
        assert_eq!(
            sql(search(&store, Some("a"), "upd cust")),
            ["UPDATE customers SET name = 'x'"]
        );
        assert_eq!(search(&store, None, "orders").len(), 2);
        assert_eq!(search(&store, Some("b"), "orders").len(), 1);
        // FTS syntax in the input is treated as text, never as an expression.
        assert!(search(&store, None, "\"orders OR NEAR(").is_empty());
        assert_eq!(search(&store, None, "* ( )").len(), 4);
    }

    #[test]
    fn delete_and_clear_keep_the_index_in_sync() {
        let store = store_with(&["a", "b"]);
        store
            .record_history(
                "a",
                &[
                    record("select alpha", HistoryStatus::Ok),
                    record("select beta", HistoryStatus::Ok),
                ],
                KEEP_ALL,
                NOW,
            )
            .expect("record");
        store
            .record_history(
                "b",
                &[record("select alpha", HistoryStatus::Ok)],
                KEEP_ALL,
                NOW,
            )
            .expect("record");
        let alpha = search(&store, Some("a"), "alpha");
        assert_eq!(store.delete_history(&[alpha[0].id]).expect("delete"), 1);
        assert!(search(&store, Some("a"), "alpha").is_empty());
        assert_eq!(search(&store, None, "alpha").len(), 1);

        assert_eq!(store.clear_history("a").expect("clear"), 1);
        assert!(search(&store, Some("a"), "").is_empty());
        assert_eq!(search(&store, Some("b"), "").len(), 1);
    }

    #[test]
    fn deleting_a_data_source_removes_its_history() {
        let store = store_with(&["a"]);
        store
            .record_history("a", &[record("select 1", HistoryStatus::Ok)], KEEP_ALL, NOW)
            .expect("record");
        store.delete_connection("a").expect("delete");
        assert_eq!(count(&store), 0);
        assert!(search(&store, None, "select").is_empty());
    }

    #[test]
    fn search_over_ten_thousand_entries_is_fast() {
        let store = store_with(&["a"]);
        let records: Vec<HistoryRecord> = (0..10_000)
            .map(|n| {
                record(
                    &format!("SELECT * FROM table_{n} WHERE value = {n} ORDER BY created_at"),
                    HistoryStatus::Ok,
                )
            })
            .collect();
        store
            .record_history("a", &records, KEEP_ALL, NOW)
            .expect("record");
        let started = Instant::now();
        let hits = search(&store, Some("a"), "table_9999");
        let keyword = search(&store, Some("a"), "order");
        let elapsed = started.elapsed();
        assert_eq!(hits.len(), 1);
        assert_eq!(keyword.len(), 100);
        assert!(elapsed.as_millis() < 100, "two searches took {elapsed:?}");
    }

    #[test]
    fn error_summary_keeps_the_first_line() {
        assert_eq!(error_summary("syntax error\nLINE 1: ..."), "syntax error");
        assert_eq!(
            error_summary(&"x".repeat(ERROR_SUMMARY_MAX + 10)).len(),
            ERROR_SUMMARY_MAX
        );
    }

    #[test]
    fn upgrading_from_version_3_turns_history_on_for_existing_profiles() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("app.db");
        {
            let mut raw = rusqlite::Connection::open(&path).expect("raw");
            crate::migrations::migrate_to(&mut raw, 3).expect("v3");
            raw.execute_batch(
                "INSERT INTO connections (id, name, engine, host, port, database, username,
                     ssl_mode, connect_timeout_secs, read_only, environment, color, save_mode)
                 VALUES ('old', 'Old', 'postgresql', 'h', 5432, 'd', 'u', 'prefer', 10, 0,
                     'none', NULL, 'never')",
            )
            .expect("v3 row");
        }
        let store = Store::open(&path).expect("upgrade");
        assert_eq!(
            store.schema_version().expect("version"),
            crate::LATEST_VERSION
        );
        let profile = store.get_connection("old").expect("get").expect("kept");
        assert!(profile.draft.history_enabled);
        let written = store
            .record_history(
                "old",
                &[record("select 1", HistoryStatus::Ok)],
                KEEP_ALL,
                NOW,
            )
            .expect("record");
        assert_eq!(written, 1);
        assert_eq!(search(&store, Some("old"), "select").len(), 1);
    }
}
