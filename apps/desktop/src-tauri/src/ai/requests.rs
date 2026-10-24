//! Consent, previews and sending (M6.2, ADR-0005). A request is built in Rust from the data
//! source's consent, shown to the user byte for byte, and sent only by the id of that preview:
//! what was shown is what is sent, and the request log keeps the same bytes.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use quarry_ai_core::PreparedRequest;
use quarry_db_core::{ExecOptions, ObjectRef, ObjectType, SchemaChange, StatementOutcome};
use quarry_store::{AiContextLevel, AiLogDraft, AiLogEntry, Environment, StoredConsent};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;

use super::context::{
    self, AiTask, MAX_INPUT_CHARS, MAX_OBJECTS, RowSample, SAMPLE_CELL_CHARS, SAMPLE_ROWS,
    SAMPLE_TABLES, SourceFacts, ViewShape,
};
use super::{Ai, AiStreamEvent, lock};
use crate::error::AppError;
use crate::sessions::{SessionKey, Sessions};

/// A preview stays sendable this long.
const PREPARED_TTL: Duration = Duration::from_secs(15 * 60);
/// Previews kept at once; the oldest go first.
const MAX_PREPARED: usize = 20;

/// A previewed request waiting for Send.
pub struct Prepared {
    connection_id: String,
    connection_name: String,
    action: &'static str,
    level: AiContextLevel,
    rows_sent: bool,
    request: PreparedRequest,
    created: Instant,
}

/// A data source's consent as it applies now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiConsent {
    pub connection_id: String,
    /// What may be sent now; `none` until the user decides.
    pub level: AiContextLevel,
    /// The user chose a level (remembered, or for this run of the app).
    pub decided: bool,
    /// Kept in app.db (otherwise it lasts until the app restarts).
    pub remembered: bool,
    pub rows_always: bool,
    /// What the consent dialog preselects: `none` for production sources.
    pub suggested: AiContextLevel,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiPreviewRequest {
    pub connection_id: String,
    pub task: AiTask,
    /// The editor's statement or selection.
    pub sql: String,
    /// Objects selected or referenced by the SQL (resolved by the editor).
    pub objects: Vec<ObjectRef>,
    /// The user confirmed sending sample rows for this request.
    pub include_rows: bool,
}

/// Why an object is not in the request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum OmitReason {
    /// On the ignore list.
    Ignored,
    /// The request would be too large.
    Size,
    /// It no longer exists.
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiOmitted {
    pub name: String,
    pub reason: OmitReason,
}

/// Rows that are (or would be) sampled from one table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiRowTable {
    pub table: String,
    pub columns: Vec<String>,
    pub rows: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiPreview {
    pub payload_id: String,
    pub connection_id: String,
    pub model: String,
    pub level: AiContextLevel,
    /// The exact request body that Send transmits.
    pub body: String,
    pub bytes: u64,
    /// Rough count (four bytes a token), for the size shown next to the payload.
    pub estimated_tokens: u64,
    /// Objects whose schema is included.
    pub objects: Vec<String>,
    pub omitted: Vec<AiOmitted>,
    /// Sample rows included.
    pub rows: Vec<AiRowTable>,
    /// Sample rows that could be included after the row consent prompt (columns and cap).
    pub row_offer: Vec<AiRowTable>,
}

fn qualified(schema: &str, name: &str) -> String {
    format!("{schema}.{name}")
}

fn sql_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn stale() -> AppError {
    AppError::new(
        "ai_preview_expired",
        "This preview is no longer valid. Preview the request again.",
    )
}

impl Ai {
    fn profile(&self, connection_id: &str) -> Result<quarry_store::ConnectionProfile, AppError> {
        self.store
            .get_connection(connection_id)?
            .ok_or_else(|| AppError::new("not_found", "data source not found"))
    }

    /// Blocking.
    pub fn consent(&self, connection_id: &str) -> Result<AiConsent, AppError> {
        let profile = self.profile(connection_id)?;
        let suggested = if profile.draft.environment == Environment::Production {
            AiContextLevel::None
        } else {
            AiContextLevel::Schema
        };
        let stored = self.store.ai_consent(connection_id)?;
        let once = lock(&self.once).get(connection_id).copied();
        Ok(match (stored, once) {
            (
                Some(StoredConsent {
                    level, rows_always, ..
                }),
                _,
            ) => AiConsent {
                connection_id: connection_id.to_owned(),
                level,
                decided: true,
                remembered: true,
                rows_always,
                suggested,
            },
            (None, Some(level)) => AiConsent {
                connection_id: connection_id.to_owned(),
                level,
                decided: true,
                remembered: false,
                rows_always: false,
                suggested,
            },
            (None, None) => AiConsent {
                connection_id: connection_id.to_owned(),
                level: AiContextLevel::None,
                decided: false,
                remembered: false,
                rows_always: false,
                suggested,
            },
        })
    }

    /// Blocking. Every data source with a decision.
    pub fn consents(&self) -> Result<Vec<AiConsent>, AppError> {
        let mut ids: Vec<String> = self
            .store
            .ai_consents()?
            .into_iter()
            .map(|c| c.connection_id)
            .collect();
        ids.extend(lock(&self.once).keys().cloned());
        ids.sort();
        ids.dedup();
        // A data source deleted meanwhile has no consent left to show.
        Ok(ids.iter().filter_map(|id| self.consent(id).ok()).collect())
    }

    /// Blocking. `remember` keeps the choice in app.db; otherwise it lasts until restart.
    pub fn set_consent(
        &self,
        connection_id: &str,
        level: AiContextLevel,
        remember: bool,
        rows_always: bool,
    ) -> Result<AiConsent, AppError> {
        self.profile(connection_id)?;
        if rows_always && !remember {
            return Err(AppError::new(
                "invalid",
                "Sample rows can be always allowed only for a remembered choice.",
            ));
        }
        if remember {
            self.store
                .set_ai_consent(connection_id, level, rows_always)?;
            lock(&self.once).remove(connection_id);
        } else {
            self.store.revoke_ai_consent(connection_id)?;
            lock(&self.once).insert(connection_id.to_owned(), level);
        }
        self.drop_prepared(connection_id);
        tracing::info!(source = %connection_id, level = level.as_str(), remember, rows_always, "AI consent set");
        self.consent(connection_id)
    }

    /// Blocking. Back to undecided; previews waiting for Send are discarded.
    pub fn revoke_consent(&self, connection_id: &str) -> Result<AiConsent, AppError> {
        self.store.revoke_ai_consent(connection_id)?;
        lock(&self.once).remove(connection_id);
        self.drop_prepared(connection_id);
        tracing::info!(source = %connection_id, "AI consent revoked");
        self.consent(connection_id)
    }

    fn drop_prepared(&self, connection_id: &str) {
        lock(&self.prepared).retain(|_, p| p.connection_id != connection_id);
    }

    fn keep_prepared(&self, id: String, prepared: Prepared) {
        let mut all = lock(&self.prepared);
        all.retain(|_, p| p.created.elapsed() < PREPARED_TTL);
        while all.len() >= MAX_PREPARED {
            let oldest = all
                .iter()
                .min_by_key(|(_, p)| p.created)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => all.remove(&k),
                None => break,
            };
        }
        all.insert(id, prepared);
    }

    /// Builds the request for `input` from the consent as it is now, and keeps it for Send.
    pub async fn preview(
        self: &Arc<Self>,
        sessions: &Sessions,
        input: AiPreviewRequest,
    ) -> Result<AiPreview, AppError> {
        self.switch.check()?;
        if input.sql.len() > MAX_INPUT_CHARS || input.task.text().len() > MAX_INPUT_CHARS {
            return Err(AppError::new(
                "invalid",
                "The text is too long to send. Select a smaller part.",
            ));
        }
        let this = Arc::clone(self);
        let id = input.connection_id.clone();
        let (consent, profile, settings) = tauri::async_runtime::spawn_blocking(move || {
            Ok::<_, AppError>((
                this.consent(&id)?,
                this.profile(&id)?,
                this.store.ai_settings()?,
            ))
        })
        .await
        .map_err(|e| AppError::new("internal", format!("AI task failed: {e}")))??;
        let level = consent.level;
        let key = SessionKey::shared(&input.connection_id);
        let live = if level >= AiContextLevel::Schema {
            Some(sessions.get(&key).await.map_err(|_| {
                AppError::new(
                    "not_connected",
                    format!(
                        "Connect to {} to include its schema, or send the SQL text only.",
                        profile.draft.name
                    ),
                )
            })?)
        } else {
            sessions.get(&key).await.ok()
        };
        let facts = SourceFacts {
            dialect: "PostgreSQL",
            server_version: live.as_ref().map(|s| s.info().server_version.clone()),
        };

        let mut schema_text = String::new();
        let mut objects = Vec::new();
        let mut omitted = Vec::new();
        let mut row_tables: Vec<(String, String, Vec<String>)> = Vec::new();
        if let Some(live) = live.as_ref().filter(|_| level >= AiContextLevel::Schema) {
            let mut queue: Vec<ObjectRef> = Vec::new();
            let mut seen = HashSet::new();
            for o in input.objects.iter().take(MAX_OBJECTS) {
                if seen.insert((o.schema.clone(), o.name.clone())) {
                    queue.push(o.clone());
                }
            }
            let referenced = queue.len();
            let mut items = Vec::new();
            let mut index = 0;
            while index < queue.len() && index < MAX_OBJECTS {
                let object = queue[index].clone();
                index += 1;
                let name = qualified(&object.schema, &object.name);
                let text = match object.object_type {
                    ObjectType::Table => {
                        let Some(model) = live.table_model(&object.schema, &object.name).await?
                        else {
                            omitted.push(AiOmitted {
                                name,
                                reason: OmitReason::Missing,
                            });
                            continue;
                        };
                        let Some(model) = context::filter_table(model, &settings) else {
                            omitted.push(AiOmitted {
                                name,
                                reason: OmitReason::Ignored,
                            });
                            continue;
                        };
                        // Tables the user referenced may be sampled; their neighbours are only
                        // described.
                        if index <= referenced && row_tables.len() < SAMPLE_TABLES {
                            row_tables.push((
                                model.schema.clone(),
                                model.name.clone(),
                                model.columns.iter().map(|c| c.name.clone()).collect(),
                            ));
                        }
                        for fk in &model.foreign_keys {
                            if seen.insert((fk.ref_schema.clone(), fk.ref_table.clone())) {
                                queue.push(ObjectRef {
                                    schema: fk.ref_schema.clone(),
                                    name: fk.ref_table.clone(),
                                    object_type: ObjectType::Table,
                                });
                            }
                        }
                        let statements =
                            sessions.preview_schema(&SchemaChange::CreateTable { table: model })?;
                        statements
                            .iter()
                            .map(|s| format!("{};", s.trim_end_matches(';')))
                            .collect::<Vec<_>>()
                            .join("\n")
                    }
                    ObjectType::View | ObjectType::MaterializedView => {
                        let Some(details) = live.object_details(&object).await? else {
                            omitted.push(AiOmitted {
                                name,
                                reason: OmitReason::Missing,
                            });
                            continue;
                        };
                        let shape = ViewShape {
                            schema: object.schema.clone(),
                            name: object.name.clone(),
                            columns: details
                                .columns
                                .iter()
                                .map(|c| (c.name.clone(), c.type_name.clone()))
                                .collect(),
                        };
                        let Some(shape) = context::filter_view(shape, &settings) else {
                            omitted.push(AiOmitted {
                                name,
                                reason: OmitReason::Ignored,
                            });
                            continue;
                        };
                        context::view_text(&shape)
                    }
                };
                items.push((name, text));
            }
            let (text, included, left_out) = context::fit_schema(items);
            schema_text = text;
            objects = included;
            omitted.extend(left_out.into_iter().map(|name| AiOmitted {
                name,
                reason: OmitReason::Size,
            }));
            row_tables.retain(|(s, t, _)| objects.contains(&qualified(s, t)));
        }
        self.finish_preview(
            sessions,
            &input,
            &profile.draft.name,
            level,
            consent.rows_always,
            facts,
            schema_text,
            objects,
            omitted,
            row_tables,
            &settings.model,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn finish_preview(
        self: &Arc<Self>,
        sessions: &Sessions,
        input: &AiPreviewRequest,
        connection_name: &str,
        level: AiContextLevel,
        rows_always: bool,
        facts: SourceFacts,
        schema_text: String,
        objects: Vec<String>,
        omitted: Vec<AiOmitted>,
        row_tables: Vec<(String, String, Vec<String>)>,
        model: &str,
    ) -> Result<AiPreview, AppError> {
        let offer: Vec<AiRowTable> = if level == AiContextLevel::SchemaAndRows {
            row_tables
                .iter()
                .filter(|(_, _, cols)| !cols.is_empty())
                .map(|(s, t, cols)| AiRowTable {
                    table: qualified(s, t),
                    columns: cols.clone(),
                    rows: SAMPLE_ROWS as u32,
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut samples = Vec::new();
        if !offer.is_empty() && (input.include_rows || rows_always) {
            let live = sessions
                .get(&SessionKey::shared(&input.connection_id))
                .await?;
            for (schema, table, columns) in row_tables.iter().filter(|(_, _, c)| !c.is_empty()) {
                let sql = format!(
                    "SELECT {} FROM {}.{} LIMIT {SAMPLE_ROWS}",
                    columns
                        .iter()
                        .map(|c| sql_ident(c))
                        .collect::<Vec<_>>()
                        .join(", "),
                    sql_ident(schema),
                    sql_ident(table)
                );
                let outcome = live
                    .execute(
                        &sql,
                        &ExecOptions {
                            max_rows: SAMPLE_ROWS,
                            max_cell_chars: SAMPLE_CELL_CHARS,
                        },
                    )
                    .await?;
                if let StatementOutcome::Rows { rows, cursor, .. } = outcome {
                    if let Some(cursor) = cursor {
                        let _ = live.close_cursor(&cursor).await;
                    }
                    samples.push(RowSample {
                        schema: schema.clone(),
                        table: table.clone(),
                        columns: columns.clone(),
                        rows: rows.into_iter().take(SAMPLE_ROWS).collect(),
                    });
                }
            }
        }
        let request = context::build_request(
            &facts,
            &input.task,
            &input.sql,
            level,
            &schema_text,
            &samples,
            model,
        );
        let prepared = quarry_ai_anthropic::prepare(&request);
        let rows: Vec<AiRowTable> = samples
            .iter()
            .map(|s| AiRowTable {
                table: qualified(&s.schema, &s.table),
                columns: s.columns.clone(),
                rows: s.rows.len() as u32,
            })
            .collect();
        let payload_id = uuid::Uuid::new_v4().to_string();
        let preview = AiPreview {
            payload_id: payload_id.clone(),
            connection_id: input.connection_id.clone(),
            model: prepared.model.clone(),
            level,
            bytes: prepared.body.len() as u64,
            estimated_tokens: (prepared.body.len() as u64).div_ceil(4),
            body: prepared.body.clone(),
            objects,
            omitted,
            row_offer: if rows.is_empty() { offer } else { Vec::new() },
            rows,
        };
        self.keep_prepared(
            payload_id,
            Prepared {
                connection_id: input.connection_id.clone(),
                connection_name: connection_name.to_owned(),
                action: input.task.action(),
                level,
                rows_sent: !samples.is_empty(),
                request: prepared,
                created: Instant::now(),
            },
        );
        tracing::info!(
            source = %input.connection_id,
            action = input.task.action(),
            level = level.as_str(),
            objects = preview.objects.len(),
            rows = !preview.rows.is_empty(),
            bytes = preview.bytes,
            "AI request previewed"
        );
        Ok(preview)
    }

    /// Takes a previewed request; fails if it is unknown, expired, or the consent it was built
    /// under no longer holds (revoked or lowered since).
    pub fn take_prepared(&self, payload_id: &str) -> Result<Prepared, AppError> {
        let prepared = lock(&self.prepared).remove(payload_id).ok_or_else(stale)?;
        if prepared.created.elapsed() >= PREPARED_TTL {
            return Err(stale());
        }
        let consent = self.consent(&prepared.connection_id)?;
        let allowed = consent.level >= prepared.level
            && (!prepared.rows_sent || consent.level == AiContextLevel::SchemaAndRows);
        if !allowed {
            return Err(AppError::new(
                "ai_consent",
                "The consent for this data source changed after the preview. Preview again.",
            ));
        }
        Ok(prepared)
    }

    /// Sends a previewed request by its id, records it in the request log, and streams the
    /// answer to `sink`.
    pub async fn send<F>(self: &Arc<Self>, payload_id: &str, sink: F) -> Result<String, AppError>
    where
        F: Fn(AiStreamEvent) + Send + 'static,
    {
        self.switch.check()?;
        let this = Arc::clone(self);
        let id = payload_id.to_owned();
        let (prepared, log_id) = tauri::async_runtime::spawn_blocking(move || {
            let prepared = this.take_prepared(&id)?;
            // The key never is part of a body, but scrub anyway in case one was pasted in.
            let mut payload = prepared.request.body.clone();
            if let Ok(Some(key)) = this.keyring.get(super::KEY_ACCOUNT)
                && !key.expose().is_empty()
                && payload.contains(key.expose())
            {
                payload = payload.replace(key.expose(), "***");
            }
            let log_id = this.store.ai_log_insert(&AiLogDraft {
                created_at: crate::exec::unix_millis(),
                connection_id: Some(prepared.connection_id.clone()),
                connection_name: prepared.connection_name.clone(),
                action: prepared.action.to_owned(),
                model: prepared.request.model.clone(),
                level: prepared.level,
                rows_sent: prepared.rows_sent,
                payload,
            })?;
            Ok::<_, AppError>((prepared, log_id))
        })
        .await
        .map_err(|e| AppError::new("internal", format!("AI task failed: {e}")))??;
        tracing::info!(log = log_id, action = prepared.action, "AI request sent");
        self.start_prepared(prepared.request, Some(log_id), sink)
            .await
    }
}

type AiState<'a> = State<'a, Arc<Ai>>;

async fn blocking<T, F>(ai: &Arc<Ai>, f: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&Ai) -> Result<T, AppError> + Send + 'static,
{
    let ai = Arc::clone(ai);
    tauri::async_runtime::spawn_blocking(move || f(&ai))
        .await
        .map_err(|e| AppError::new("internal", format!("AI task failed: {e}")))?
}

#[tauri::command]
pub async fn ai_consents_list(ai: AiState<'_>) -> Result<Vec<AiConsent>, AppError> {
    blocking(&ai, |a| a.consents()).await
}

#[tauri::command]
pub async fn ai_consent_get(ai: AiState<'_>, connection_id: String) -> Result<AiConsent, AppError> {
    blocking(&ai, move |a| a.consent(&connection_id)).await
}

#[tauri::command]
pub async fn ai_consent_set(
    ai: AiState<'_>,
    connection_id: String,
    level: AiContextLevel,
    remember: bool,
    rows_always: bool,
) -> Result<AiConsent, AppError> {
    blocking(&ai, move |a| {
        a.set_consent(&connection_id, level, remember, rows_always)
    })
    .await
}

#[tauri::command]
pub async fn ai_consent_revoke(
    ai: AiState<'_>,
    connection_id: String,
) -> Result<AiConsent, AppError> {
    blocking(&ai, move |a| a.revoke_consent(&connection_id)).await
}

#[tauri::command]
pub async fn ai_context_preview(
    ai: AiState<'_>,
    sessions: State<'_, Arc<Sessions>>,
    request: AiPreviewRequest,
) -> Result<AiPreview, AppError> {
    ai.preview(&sessions, request).await
}

/// Sends a previewed request; resolves to the request id at once (for `ai_cancel`).
#[tauri::command]
pub async fn ai_send(
    ai: AiState<'_>,
    payload_id: String,
    on_event: Channel<AiStreamEvent>,
) -> Result<String, AppError> {
    ai.send(&payload_id, move |event| {
        let _ = on_event.send(event);
    })
    .await
}

#[tauri::command]
pub async fn ai_log_list(ai: AiState<'_>, limit: u32) -> Result<Vec<AiLogEntry>, AppError> {
    blocking(&ai, move |a| Ok(a.store.ai_log_list(limit)?)).await
}

#[tauri::command]
pub async fn ai_log_clear(ai: AiState<'_>) -> Result<usize, AppError> {
    blocking(&ai, |a| {
        let n = a.store.ai_log_clear()?;
        tracing::info!(entries = n, "AI request log cleared");
        Ok(n)
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use quarry_db_core::{ConnectParams, DatabaseAdapter, TlsMode};
    use quarry_db_postgres::PostgresAdapter;
    use quarry_secrets::SecretString;
    use quarry_store::{
        AiIgnoreKind, AiIgnoreRule, AiLogStatus, AiSettings, ConnectionDraft, Environment,
        SaveMode, SslMode, Store,
    };
    use tokio::sync::mpsc;

    use super::super::testing::{ai_with, api_streaming};
    use super::*;

    const KEY: &str = "sk-ant-api03-LEAK-CANARY-log-91ab";

    fn store() -> Arc<Store> {
        let store = Store::open_in_memory().expect("store");
        for (id, environment) in [
            ("dev", Environment::Development),
            ("prod", Environment::Production),
        ] {
            store
                .insert_connection(
                    id,
                    ConnectionDraft {
                        name: format!("{id} db"),
                        host: "127.0.0.1".into(),
                        port: 55432,
                        database: "quarry_test".into(),
                        username: "quarry".into(),
                        ssl_mode: SslMode::Disable,
                        connect_timeout_secs: 5,
                        environment,
                        save_mode: SaveMode::Never,
                        ..ConnectionDraft::default()
                    },
                )
                .expect("profile");
        }
        Arc::new(store)
    }

    fn sessions() -> Sessions {
        Sessions::new(Arc::new(PostgresAdapter))
    }

    fn ask(connection_id: &str, sql: &str) -> AiPreviewRequest {
        AiPreviewRequest {
            connection_id: connection_id.into(),
            task: AiTask::Ask {
                question: "What does this do?".into(),
            },
            sql: sql.into(),
            objects: Vec::new(),
            include_rows: false,
        }
    }

    fn on(ai: &Ai) {
        ai.set_settings(&AiSettings {
            enabled: true,
            ..AiSettings::default()
        })
        .expect("on");
    }

    #[test]
    fn production_sources_default_to_none_and_others_suggest_schema() {
        let ai = ai_with(store(), "http://127.0.0.1:9");
        let prod = ai.consent("prod").expect("prod");
        assert_eq!(prod.level, AiContextLevel::None);
        assert_eq!(prod.suggested, AiContextLevel::None);
        assert!(!prod.decided);
        let dev = ai.consent("dev").expect("dev");
        assert_eq!(
            dev.level,
            AiContextLevel::None,
            "nothing until the user decides"
        );
        assert_eq!(dev.suggested, AiContextLevel::Schema);
        assert!(ai.consents().expect("list").is_empty());
    }

    #[test]
    fn consent_is_remembered_or_kept_until_restart_and_can_be_revoked() {
        let store = store();
        let ai = ai_with(Arc::clone(&store), "http://127.0.0.1:9");
        let c = ai
            .set_consent("dev", AiContextLevel::Schema, false, false)
            .expect("once");
        assert!(c.decided && !c.remembered);
        assert!(
            store.ai_consent("dev").expect("db").is_none(),
            "not in app.db"
        );
        let c = ai
            .set_consent("dev", AiContextLevel::SchemaAndRows, true, true)
            .expect("remember");
        assert!(c.remembered && c.rows_always);
        assert_eq!(ai.consents().expect("list").len(), 1);
        // A fresh app (same app.db) still knows the remembered choice.
        let again = ai_with(Arc::clone(&store), "http://127.0.0.1:9");
        assert_eq!(
            again.consent("dev").expect("get").level,
            AiContextLevel::SchemaAndRows
        );
        let err = ai
            .set_consent("dev", AiContextLevel::SchemaAndRows, false, true)
            .expect_err("always needs remember");
        assert_eq!(err.kind, "invalid");
        let c = ai.revoke_consent("dev").expect("revoke");
        assert!(!c.decided);
        assert_eq!(c.level, AiContextLevel::None);
        assert!(store.ai_consent("dev").expect("db").is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn previews_need_ai_on_and_level_none_sends_only_the_text() {
        let ai = ai_with(store(), "http://127.0.0.1:9");
        let sessions = sessions();
        let err = ai
            .preview(&sessions, ask("dev", "select 1"))
            .await
            .expect_err("off");
        assert_eq!(err.kind, "ai_disabled");
        on(&ai);
        let p = ai
            .preview(&sessions, ask("prod", "select * from accounts"))
            .await
            .expect("preview");
        assert_eq!(p.level, AiContextLevel::None);
        assert!(p.body.contains("select * from accounts"));
        assert!(p.body.contains("What does this do?"));
        assert!(!p.body.contains("Schema of the objects"));
        assert_eq!(p.bytes, p.body.len() as u64);
        assert!(p.objects.is_empty() && p.rows.is_empty() && p.row_offer.is_empty());
        // Schema consent without a connection: a clear error, not a silent downgrade.
        ai.set_consent("dev", AiContextLevel::Schema, false, false)
            .expect("consent");
        let err = ai
            .preview(&sessions, ask("dev", "select 1"))
            .await
            .expect_err("not connected");
        assert_eq!(err.kind, "not_connected");
    }

    fn prepared(ai: &Ai, connection_id: &str, level: AiContextLevel, rows_sent: bool) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        ai.keep_prepared(
            id.clone(),
            Prepared {
                connection_id: connection_id.into(),
                connection_name: "dev db".into(),
                action: "ask",
                level,
                rows_sent,
                request: PreparedRequest {
                    model: "m".into(),
                    body: "{}".into(),
                },
                created: Instant::now(),
            },
        );
        id
    }

    #[test]
    fn send_accepts_only_a_previewed_payload_once() {
        let ai = ai_with(store(), "http://127.0.0.1:9");
        let id = prepared(&ai, "dev", AiContextLevel::None, false);
        assert_eq!(
            ai.take_prepared("some-other-id").err().map(|e| e.kind),
            Some("ai_preview_expired")
        );
        assert!(ai.take_prepared(&id).is_ok());
        assert_eq!(
            ai.take_prepared(&id).err().map(|e| e.kind),
            Some("ai_preview_expired"),
            "a payload is sent at most once"
        );
    }

    #[test]
    fn revoking_or_lowering_consent_invalidates_previews() {
        let ai = ai_with(store(), "http://127.0.0.1:9");
        ai.set_consent("dev", AiContextLevel::SchemaAndRows, true, false)
            .expect("consent");
        // Built with rows; the consent is lowered to schema meanwhile.
        let rows = prepared(&ai, "dev", AiContextLevel::SchemaAndRows, true);
        ai.store
            .set_ai_consent("dev", AiContextLevel::Schema, false)
            .expect("lower behind the registry's back");
        assert_eq!(
            ai.take_prepared(&rows).err().map(|e| e.kind),
            Some("ai_consent")
        );
        // Revoke drops waiting previews at once.
        let schema = prepared(&ai, "dev", AiContextLevel::Schema, false);
        ai.revoke_consent("dev").expect("revoke");
        assert_eq!(
            ai.take_prepared(&schema).err().map(|e| e.kind),
            Some("ai_preview_expired")
        );
        // Level none needs no consent at all.
        let none = prepared(&ai, "dev", AiContextLevel::None, false);
        assert!(ai.take_prepared(&none).is_ok());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_log_holds_exactly_what_was_sent_and_never_the_key() {
        let (url, _) = api_streaming(2).await;
        let ai = ai_with(store(), &url);
        ai.set_key(&SecretString::new(KEY.into())).expect("key");
        on(&ai);
        let sessions = sessions();
        let preview = ai
            .preview(&sessions, ask("dev", "select 'ünïcode' -- ✓"))
            .await
            .expect("preview");
        let (tx, mut rx) = mpsc::unbounded_channel();
        ai.send(&preview.payload_id, move |e| {
            let _ = tx.send(e);
        })
        .await
        .expect("sent");
        while let Some(event) = rx.recv().await {
            if matches!(
                event,
                AiStreamEvent::Done { .. } | AiStreamEvent::Failed { .. }
            ) {
                break;
            }
        }
        // The outcome is written just after the last event.
        let mut entry = None;
        for _ in 0..50 {
            let log = ai.store.ai_log_list(10).expect("log");
            if log.first().is_some_and(|e| e.status != AiLogStatus::Sent) {
                entry = log.into_iter().next();
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let entry = entry.expect("finished entry");
        assert_eq!(entry.payload.as_bytes(), preview.body.as_bytes());
        assert_eq!(entry.status, AiLogStatus::Done);
        assert_eq!(entry.response.as_deref(), Some("OKOK"));
        assert_eq!(entry.connection_name, "dev db");
        assert_eq!(entry.action, "ask");
        let json = serde_json::to_string(&entry).expect("encode");
        assert!(
            !json.contains("LEAK-CANARY"),
            "the key reached the request log"
        );
        assert_eq!(
            ai.send(&preview.payload_id, |_| {})
                .await
                .err()
                .map(|e| e.kind),
            Some("ai_preview_expired")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancelling_is_recorded() {
        let (url, _) = api_streaming(200).await;
        let ai = ai_with(store(), &url);
        ai.set_key(&SecretString::new(KEY.into())).expect("key");
        on(&ai);
        let preview = ai
            .preview(&sessions(), ask("dev", "select 1"))
            .await
            .expect("preview");
        let (tx, mut rx) = mpsc::unbounded_channel();
        let request = ai
            .send(&preview.payload_id, move |e| {
                let _ = tx.send(e);
            })
            .await
            .expect("sent");
        assert!(matches!(
            rx.recv().await,
            Some(AiStreamEvent::Started { .. })
        ));
        assert!(ai.cancel(&request));
        let log = ai.store.ai_log_list(1).expect("log");
        assert_eq!(log[0].status, AiLogStatus::Cancelled);
    }

    // ---- Against the disposable server (`scripts/test-pg.sh up` and `seed`) ----

    fn params() -> ConnectParams {
        let pw_file = format!(
            "{}/../../../target/test-pg/password",
            env!("CARGO_MANIFEST_DIR")
        );
        let password = std::fs::read_to_string(&pw_file)
            .unwrap_or_else(|e| panic!("{pw_file}: {e} (run scripts/test-pg.sh up)"))
            .trim()
            .to_owned();
        ConnectParams {
            host: "127.0.0.1".into(),
            port: 55432,
            database: "quarry_test".into(),
            username: "quarry".into(),
            password: Some(SecretString::new(password)),
            tls: TlsMode::Disable,
            connect_timeout: Duration::from_secs(5),
            read_only: false,
            application_name: "quarry-it-ai".into(),
            options: Default::default(),
        }
    }

    fn table(schema: &str, name: &str) -> ObjectRef {
        ObjectRef {
            schema: schema.into(),
            name: name.into(),
            object_type: ObjectType::Table,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs scripts/test-pg.sh up and seed"]
    async fn schema_and_rows_respect_the_ignore_list_and_the_row_consent() {
        let ai = ai_with(store(), "http://127.0.0.1:9");
        ai.set_settings(&AiSettings {
            enabled: true,
            ignore: vec![
                AiIgnoreRule {
                    kind: AiIgnoreKind::Column,
                    pattern: "*email*".into(),
                },
                AiIgnoreRule {
                    kind: AiIgnoreKind::Table,
                    pattern: "shop.products".into(),
                },
            ],
            ..AiSettings::default()
        })
        .expect("settings");
        let sessions = sessions();
        let session = PostgresAdapter
            .connect(&params(), Box::new(|_| {}))
            .await
            .expect("connect");
        sessions
            .insert_for_test(SessionKey::shared("dev"), session)
            .await;
        ai.set_consent("dev", AiContextLevel::SchemaAndRows, false, false)
            .expect("consent");

        let mut request = ask("dev", "select * from shop.order_items join shop.customers");
        request.objects = vec![
            table("shop", "order_items"),
            table("shop", "customers"),
            table("shop", "products"),
            ObjectRef {
                schema: "shop".into(),
                name: "order_totals".into(),
                object_type: ObjectType::View,
            },
        ];
        let p = ai
            .preview(&sessions, request.clone())
            .await
            .expect("preview");
        // The editor text is the user's own and is sent as typed; the context is filtered.
        let context = p
            .body
            .split("SQL in the editor")
            .next()
            .expect("context part")
            .to_lowercase();
        assert!(
            context.contains("create table shop.order_items"),
            "{context}"
        );
        assert!(context.contains("shop.orders"), "FK neighbour described");
        assert!(context.contains("create table shop.customers"));
        assert!(context.contains("order_totals"));
        assert!(!context.contains("email"), "ignored column sent: {context}");
        assert!(!context.contains("create table shop.products"));
        assert!(!context.contains("references shop.products"));
        assert!(p.omitted.contains(&AiOmitted {
            name: "shop.products".into(),
            reason: OmitReason::Ignored
        }));
        // Rows were not confirmed: none sent, but offered with their columns.
        assert!(p.rows.is_empty());
        assert!(!context.contains("sample rows"));
        let offered: Vec<&str> = p.row_offer.iter().map(|t| t.table.as_str()).collect();
        assert_eq!(offered, ["shop.order_items", "shop.customers"]);
        let customers = &p.row_offer[1];
        assert!(!customers.columns.iter().any(|c| c.contains("email")));
        assert_eq!(customers.rows, SAMPLE_ROWS as u32);

        // Confirmed: sampled, still without the ignored column.
        request.include_rows = true;
        let p = ai.preview(&sessions, request.clone()).await.expect("rows");
        let context = p.body.split("SQL in the editor").next().expect("context");
        assert!(context.contains("Sample rows from shop.customers"));
        assert!(
            !context.to_lowercase().contains("@example"),
            "an email value was sent"
        );
        assert!(!p.rows.is_empty());
        assert!(p.row_offer.is_empty());

        // Schema only: no rows even when asked for.
        ai.set_consent("dev", AiContextLevel::Schema, false, false)
            .expect("lower");
        let p = ai.preview(&sessions, request).await.expect("schema");
        assert!(!p.body.contains("Sample rows"));
        assert!(p.rows.is_empty() && p.row_offer.is_empty());
    }
}
