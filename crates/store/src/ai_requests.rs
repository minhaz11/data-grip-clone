//! AI consent per data source and the local AI request log (M6.2, ADR-0005).
//!
//! A consent row exists only when the user chose "remember"; a one-time choice is kept in memory
//! by the caller. The log keeps each request body exactly as it was sent (the API key travels in
//! a header, never in a body) plus a summary of the answer, so the user can see what left the
//! machine.

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

/// How much of a data source may be sent with a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum AiContextLevel {
    /// Only the SQL text in the editor.
    None,
    /// Plus names, types and keys of the objects involved.
    Schema,
    /// Plus a few sample rows, each time confirmed (or always allowed).
    SchemaAndRows,
}

impl AiContextLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Schema => "schema",
            Self::SchemaAndRows => "schemaAndRows",
        }
    }

    pub fn parse(s: &str) -> Result<Self, StoreError> {
        match s {
            "none" => Ok(Self::None),
            "schema" => Ok(Self::Schema),
            "schemaAndRows" => Ok(Self::SchemaAndRows),
            other => Err(StoreError::Invalid(format!(
                "unknown context level '{other}'"
            ))),
        }
    }
}

/// A remembered consent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StoredConsent {
    pub connection_id: String,
    pub level: AiContextLevel,
    /// Sample rows may be sent without asking each time.
    pub rows_always: bool,
    pub granted_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum AiLogStatus {
    /// Sent; no answer yet (or the app closed meanwhile).
    Sent,
    Done,
    Failed,
    Cancelled,
}

impl AiLogStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Sent => "sent",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "done" => Self::Done,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Sent,
        }
    }
}

/// What is recorded when a request is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiLogDraft {
    pub created_at: i64,
    pub connection_id: Option<String>,
    pub connection_name: String,
    pub action: String,
    pub model: String,
    pub level: AiContextLevel,
    pub rows_sent: bool,
    /// The request body, byte for byte as sent.
    pub payload: String,
}

/// How a request ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiLogOutcome {
    pub status: AiLogStatus,
    pub response: Option<String>,
    pub error: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub finished_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiLogEntry {
    pub id: i64,
    /// Unix milliseconds.
    pub created_at: i64,
    pub connection_id: Option<String>,
    pub connection_name: String,
    pub action: String,
    pub model: String,
    pub level: AiContextLevel,
    pub rows_sent: bool,
    pub payload: String,
    pub status: AiLogStatus,
    pub response: Option<String>,
    pub error: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub finished_at: Option<i64>,
}

/// Entries kept; the oldest go first.
pub const AI_LOG_LIMIT: i64 = 500;
/// Characters of an answer kept in the log.
pub const AI_LOG_RESPONSE_CHARS: usize = 20_000;

fn consent_from(row: &Row<'_>) -> rusqlite::Result<(String, String, bool, String)> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
}

fn consent(
    (connection_id, level, rows_always, granted_at): (String, String, bool, String),
) -> Result<StoredConsent, StoreError> {
    Ok(StoredConsent {
        connection_id,
        level: AiContextLevel::parse(&level)?,
        rows_always,
        granted_at,
    })
}

const CONSENT_COLUMNS: &str = "connection_id, level, rows_always, granted_at";
const LOG_COLUMNS: &str = "id, created_at, connection_id, connection_name, action, model, level, \
     rows_sent, payload, status, response, error, input_tokens, output_tokens, finished_at";

fn log_entry(row: &Row<'_>) -> rusqlite::Result<AiLogEntry> {
    let level: String = row.get(6)?;
    let status: String = row.get(9)?;
    Ok(AiLogEntry {
        id: row.get(0)?,
        created_at: row.get(1)?,
        connection_id: row.get(2)?,
        connection_name: row.get(3)?,
        action: row.get(4)?,
        model: row.get(5)?,
        level: AiContextLevel::parse(&level).unwrap_or(AiContextLevel::None),
        rows_sent: row.get(7)?,
        payload: row.get(8)?,
        status: AiLogStatus::parse(&status),
        response: row.get(10)?,
        error: row.get(11)?,
        input_tokens: row.get::<_, Option<i64>>(12)?.map(|n| n.max(0) as u64),
        output_tokens: row.get::<_, Option<i64>>(13)?.map(|n| n.max(0) as u64),
        finished_at: row.get(14)?,
    })
}

fn truncate(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_owned(),
    }
}

impl Store {
    pub fn ai_consent(&self, connection_id: &str) -> Result<Option<StoredConsent>, StoreError> {
        self.conn()
            .query_row(
                &format!("SELECT {CONSENT_COLUMNS} FROM ai_consents WHERE connection_id = ?1"),
                params![connection_id],
                consent_from,
            )
            .optional()?
            .map(consent)
            .transpose()
    }

    pub fn ai_consents(&self) -> Result<Vec<StoredConsent>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {CONSENT_COLUMNS} FROM ai_consents ORDER BY granted_at"
        ))?;
        let rows = stmt
            .query_map([], consent_from)?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter().map(consent).collect()
    }

    /// Remembers a consent; `rows_always` needs the rows level.
    pub fn set_ai_consent(
        &self,
        connection_id: &str,
        level: AiContextLevel,
        rows_always: bool,
    ) -> Result<StoredConsent, StoreError> {
        if rows_always && level != AiContextLevel::SchemaAndRows {
            return Err(StoreError::Invalid(
                "sample rows can be always allowed only with the schema and rows level".into(),
            ));
        }
        let changed = self.conn().execute(
            "INSERT INTO ai_consents (connection_id, level, rows_always)
             SELECT id, ?2, ?3 FROM connections WHERE id = ?1
             ON CONFLICT(connection_id) DO UPDATE SET level = excluded.level,
                 rows_always = excluded.rows_always,
                 granted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![connection_id, level.as_str(), rows_always],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound("data source".into()));
        }
        self.ai_consent(connection_id)?
            .ok_or_else(|| StoreError::NotFound("data source".into()))
    }

    /// Forgets a remembered consent; whether there was one.
    pub fn revoke_ai_consent(&self, connection_id: &str) -> Result<bool, StoreError> {
        Ok(self.conn().execute(
            "DELETE FROM ai_consents WHERE connection_id = ?1",
            params![connection_id],
        )? > 0)
    }

    /// Records a request as it is sent; returns its id. Keeps the newest [`AI_LOG_LIMIT`].
    pub fn ai_log_insert(&self, draft: &AiLogDraft) -> Result<i64, StoreError> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO ai_request_log (created_at, connection_id, connection_name, action, model,
                 level, rows_sent, payload, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'sent')",
            params![
                draft.created_at,
                draft.connection_id,
                draft.connection_name,
                draft.action,
                draft.model,
                draft.level.as_str(),
                draft.rows_sent,
                draft.payload,
            ],
        )?;
        let id = conn.last_insert_rowid();
        conn.execute(
            "DELETE FROM ai_request_log WHERE id NOT IN
                 (SELECT id FROM ai_request_log ORDER BY created_at DESC, id DESC LIMIT ?1)",
            params![AI_LOG_LIMIT],
        )?;
        Ok(id)
    }

    pub fn ai_log_finish(&self, id: i64, outcome: &AiLogOutcome) -> Result<(), StoreError> {
        let response = outcome
            .response
            .as_deref()
            .map(|r| truncate(r, AI_LOG_RESPONSE_CHARS));
        self.conn().execute(
            "UPDATE ai_request_log SET status = ?2, response = ?3, error = ?4, input_tokens = ?5,
                 output_tokens = ?6, finished_at = ?7
             WHERE id = ?1",
            params![
                id,
                outcome.status.as_str(),
                response,
                outcome.error,
                outcome.input_tokens.map(|n| n as i64),
                outcome.output_tokens.map(|n| n as i64),
                outcome.finished_at,
            ],
        )?;
        Ok(())
    }

    /// Newest first.
    pub fn ai_log_list(&self, limit: u32) -> Result<Vec<AiLogEntry>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {LOG_COLUMNS} FROM ai_request_log ORDER BY created_at DESC, id DESC LIMIT ?1"
        ))?;
        let rows = stmt
            .query_map(params![limit.min(AI_LOG_LIMIT as u32)], log_entry)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Removes every entry; returns how many there were.
    pub fn ai_log_clear(&self) -> Result<usize, StoreError> {
        Ok(self.conn().execute("DELETE FROM ai_request_log", [])?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ConnectionDraft, SaveMode};

    fn store_with_source() -> (Store, String) {
        let store = Store::open_in_memory().expect("store");
        let profile = store
            .insert_connection(
                "c1",
                ConnectionDraft {
                    name: "dev".into(),
                    host: "localhost".into(),
                    port: 5432,
                    database: "app".into(),
                    username: "u".into(),
                    connect_timeout_secs: 10,
                    save_mode: SaveMode::Never,
                    ..ConnectionDraft::default()
                },
            )
            .expect("connection");
        (store, profile.id)
    }

    #[test]
    fn consents_are_remembered_revoked_and_go_with_their_source() {
        let (store, id) = store_with_source();
        assert_eq!(store.ai_consent(&id).expect("get"), None);
        let c = store
            .set_ai_consent(&id, AiContextLevel::Schema, false)
            .expect("set");
        assert_eq!(c.level, AiContextLevel::Schema);
        let c = store
            .set_ai_consent(&id, AiContextLevel::SchemaAndRows, true)
            .expect("raise");
        assert!(c.rows_always);
        assert_eq!(store.ai_consents().expect("list").len(), 1);
        assert!(matches!(
            store.set_ai_consent(&id, AiContextLevel::Schema, true),
            Err(StoreError::Invalid(_))
        ));
        assert!(matches!(
            store.set_ai_consent("missing", AiContextLevel::Schema, false),
            Err(StoreError::NotFound(_))
        ));
        assert!(store.revoke_ai_consent(&id).expect("revoke"));
        assert!(!store.revoke_ai_consent(&id).expect("again"));
        assert_eq!(store.ai_consent(&id).expect("get"), None);

        store
            .set_ai_consent(&id, AiContextLevel::Schema, false)
            .expect("set");
        store.delete_connection(&id).expect("delete");
        assert!(store.ai_consents().expect("list").is_empty());
    }

    fn draft(n: i64) -> AiLogDraft {
        AiLogDraft {
            created_at: n,
            connection_id: Some("c1".into()),
            connection_name: "dev".into(),
            action: "ask".into(),
            model: "claude-sonnet-5-5".into(),
            level: AiContextLevel::Schema,
            rows_sent: false,
            payload: format!("{{\"n\":{n},\"text\":\"select 'é' -- ✓\"}}"),
        }
    }

    #[test]
    fn log_keeps_payloads_byte_for_byte_and_outcomes() {
        let (store, _) = store_with_source();
        let d = draft(1);
        let id = store.ai_log_insert(&d).expect("insert");
        let entry = &store.ai_log_list(10).expect("list")[0];
        assert_eq!(entry.payload.as_bytes(), d.payload.as_bytes());
        assert_eq!(entry.status, AiLogStatus::Sent);
        store
            .ai_log_finish(
                id,
                &AiLogOutcome {
                    status: AiLogStatus::Done,
                    response: Some("x".repeat(AI_LOG_RESPONSE_CHARS + 10)),
                    error: None,
                    input_tokens: Some(12),
                    output_tokens: Some(3),
                    finished_at: 2,
                },
            )
            .expect("finish");
        let entry = &store.ai_log_list(10).expect("list")[0];
        assert_eq!(entry.status, AiLogStatus::Done);
        assert_eq!(entry.input_tokens, Some(12));
        assert_eq!(
            entry.response.as_ref().map(|r| r.chars().count()),
            Some(AI_LOG_RESPONSE_CHARS + 1)
        );
        assert_eq!(store.ai_log_clear().expect("clear"), 1);
        assert!(store.ai_log_list(10).expect("list").is_empty());
    }

    #[test]
    fn log_keeps_the_newest_entries() {
        let (store, _) = store_with_source();
        for n in 0..AI_LOG_LIMIT + 5 {
            store.ai_log_insert(&draft(n)).expect("insert");
        }
        let all = store.ai_log_list(10_000).expect("list");
        assert_eq!(all.len() as i64, AI_LOG_LIMIT);
        assert_eq!(all[0].created_at, AI_LOG_LIMIT + 4);
        assert_eq!(all.last().map(|e| e.created_at), Some(5));
    }

    #[test]
    fn upgrades_from_version_7() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("app.db");
        {
            let mut raw = rusqlite::Connection::open(&path).expect("open");
            crate::migrations::migrate_to(&mut raw, 7).expect("v7");
        }
        let store = Store::open(&path).expect("upgrade");
        assert_eq!(store.schema_version().expect("v"), crate::LATEST_VERSION);
        assert!(store.ai_consents().expect("list").is_empty());
        assert!(store.ai_log_list(1).expect("log").is_empty());
    }
}
