//! Query jobs: a script runs statement by statement on the data source's session, streaming
//! progress to the console that started it through a Tauri `Channel`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use quarry_db_core::{Cell, DbError, ExecOptions, Notice, Session, StatementOutcome};
use quarry_store::history::error_summary;
use quarry_store::{HistoryRecord, HistoryStatus, Retention, Store};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

use crate::error::AppError;
use crate::sessions::{SessionKey, Sessions};

pub const MAX_STATEMENTS: usize = 1_000;
const MAX_ROWS_LIMIT: usize = 10_000;

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StatementRequest {
    pub sql: String,
    /// Where the statement starts in the console text; echoed back so the UI can map positions.
    pub offset: u32,
    /// Values for `$1…$n` (text; `null` is NULL), bound rather than spliced into the SQL.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub params: Option<Vec<Cell>>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    pub session: SessionKey,
    pub statements: Vec<StatementRequest>,
    #[cfg_attr(test, ts(optional))]
    pub max_rows: Option<usize>,
    /// The console's schema, put first in the search path before the statements run; absent
    /// means the server's default path.
    #[serde(default)]
    #[cfg_attr(test, ts(optional))]
    pub schema: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StatementError {
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    pub sqlstate: Option<String>,
    /// 1-based character position within the statement, from the server.
    pub position: Option<u32>,
    pub cancelled: bool,
    pub connection_lost: bool,
}

impl From<DbError> for StatementError {
    fn from(e: DbError) -> Self {
        Self {
            message: e.message,
            detail: e.detail,
            hint: e.hint,
            sqlstate: e.sqlstate,
            position: e.position,
            cancelled: e.cancelled,
            connection_lost: e.connection_lost,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "event"
)]
pub enum ExecEvent {
    StatementStarted {
        index: usize,
        offset: u32,
    },
    StatementDone {
        index: usize,
        offset: u32,
        elapsed_ms: u64,
        outcome: StatementOutcome,
    },
    StatementFailed {
        index: usize,
        offset: u32,
        elapsed_ms: u64,
        error: StatementError,
    },
    /// A server notice (`RAISE NOTICE`, warnings) raised while statement `index` ran.
    Notice {
        index: usize,
        notice: Notice,
    },
    Finished {
        status: JobStatus,
        executed: usize,
        elapsed_ms: u64,
    },
}

struct Job {
    key: SessionKey,
    session: Arc<dyn Session>,
    cancel_requested: AtomicBool,
}

/// Where a job records its statements (REQ-HIST-01).
struct History {
    store: Arc<Store>,
    retention: Retention,
}

/// What a run of statements did.
struct Script {
    status: JobStatus,
    executed: usize,
    /// One record per statement that reached the server, in order.
    history: Vec<HistoryRecord>,
}

#[derive(Default)]
pub struct Jobs {
    running: Mutex<HashMap<String, Arc<Job>>>,
}

fn millis(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
}

pub(crate) fn unix_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

impl Jobs {
    /// Whether a query job is running in session `key`.
    pub async fn running_in(&self, key: &SessionKey) -> bool {
        self.running.lock().await.values().any(|j| &j.key == key)
    }

    async fn start(
        self: &Arc<Self>,
        app: &AppHandle,
        sessions: &Arc<Sessions>,
        request: ExecRequest,
        timeout_ms: u64,
        history: History,
        channel: Channel<ExecEvent>,
    ) -> Result<String, AppError> {
        if request.statements.is_empty() {
            return Err(AppError::new("invalid", "Nothing to execute."));
        }
        if request.statements.len() > MAX_STATEMENTS {
            return Err(AppError::new(
                "invalid",
                format!("At most {MAX_STATEMENTS} statements per run."),
            ));
        }
        let key = request.session.clone();
        let session = sessions.get_or_open(app, &key).await?;
        let job_id = uuid::Uuid::new_v4().to_string();
        {
            let mut running = self.running.lock().await;
            // One job per session: a server-side cancel stops whatever the session is running.
            if running.values().any(|j| j.key == key) {
                return Err(AppError::new(
                    "busy",
                    "A query is already running in this session. Stop it first.",
                ));
            }
            running.insert(
                job_id.clone(),
                Arc::new(Job {
                    key: key.clone(),
                    session: Arc::clone(&session),
                    cancel_requested: AtomicBool::new(false),
                }),
            );
        }
        // After the busy check, so it never runs between another job's statements.
        let prepared = match sessions
            .apply_schema(&key, &session, request.schema.as_deref())
            .await
        {
            Ok(()) => sessions.apply_timeout(&key, &session, timeout_ms).await,
            Err(e) => Err(e),
        };
        if let Err(e) = prepared {
            self.running.lock().await.remove(&job_id);
            return Err(e);
        }

        let options = ExecOptions {
            max_rows: request
                .max_rows
                .unwrap_or(ExecOptions::default().max_rows)
                .clamp(1, MAX_ROWS_LIMIT),
            ..ExecOptions::default()
        };
        // SQL text and values are never logged; ids, counts and outcomes are enough to diagnose.
        tracing::info!(
            job = %job_id,
            source = %key.source_id,
            console = ?key.console,
            statements = request.statements.len(),
            "query job started"
        );
        let jobs = Arc::clone(self);
        let id = job_id.clone();
        // A running statement keeps the data source from auto-disconnecting.
        let busy = sessions.busy(&key.source_id);
        let (app, sessions) = (app.clone(), Arc::clone(sessions));
        tauri::async_runtime::spawn(async move {
            let _busy = busy;
            jobs.run(
                &id,
                request.statements,
                options,
                channel,
                history,
                &app,
                &sessions,
            )
            .await;
            jobs.running.lock().await.remove(&id);
        });
        Ok(job_id)
    }

    #[allow(clippy::too_many_arguments)]
    async fn run(
        &self,
        job_id: &str,
        statements: Vec<StatementRequest>,
        options: ExecOptions,
        channel: Channel<ExecEvent>,
        history: History,
        app: &AppHandle,
        sessions: &Sessions,
    ) {
        let Some(job) = self.running.lock().await.get(job_id).cloned() else {
            return;
        };
        let started = Instant::now();
        let script = run_statements(&job, job_id, &statements, &options, &channel, || {
            sessions.emit_state(app, &job.key)
        })
        .await;
        let elapsed_ms = millis(started);
        let (status, executed) = (script.status, script.executed);
        tracing::info!(job = %job_id, ?status, executed, elapsed_ms, "query job finished");
        let _ = channel.send(ExecEvent::Finished {
            status,
            executed,
            elapsed_ms,
        });
        // Recorded here, not by the UI, so the history is complete even if the window goes away.
        let source_id = job.key.source_id.clone();
        let History { store, retention } = history;
        let records = script.history;
        let written = tauri::async_runtime::spawn_blocking(move || {
            store.record_history(&source_id, &records, retention, unix_millis())
        })
        .await;
        match written {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                tracing::warn!(job = %job_id, error = %e, "could not record query history")
            }
            Err(e) => tracing::warn!(job = %job_id, error = %e, "query history task failed"),
        }
    }

    async fn cancel(&self, job_id: &str) -> Result<(), AppError> {
        let job = self.running.lock().await.get(job_id).cloned();
        let Some(job) = job else { return Ok(()) }; // already finished
        job.cancel_requested.store(true, Ordering::SeqCst);
        tracing::info!(job = %job_id, "cancel requested");
        job.session.cancel().await.map_err(AppError::from)
    }
}

/// Runs `statements` in order on the job's session, sending progress on `channel`, and stops at the
/// first error or cancel. `on_tx_change` runs whenever a statement changes the transaction state.
async fn run_statements<F, Fut>(
    job: &Job,
    job_id: &str,
    statements: &[StatementRequest],
    options: &ExecOptions,
    channel: &Channel<ExecEvent>,
    on_tx_change: F,
) -> Script
where
    F: Fn() -> Fut,
    Fut: Future<Output = ()>,
{
    let mut status = JobStatus::Completed;
    let mut executed = 0;
    let mut history = Vec::with_capacity(statements.len());
    let tx_mode = job.session.tx_settings().mode;
    // Notices go to this job's channel, tagged with the statement running when they came.
    let current = Arc::new(AtomicUsize::new(0));
    {
        let current = Arc::clone(&current);
        let channel = channel.clone();
        job.session.set_notice_sink(Some(Arc::new(move |notice| {
            let index = current.load(Ordering::SeqCst);
            let _ = channel.send(ExecEvent::Notice { index, notice });
        })));
    }
    for (index, statement) in statements.iter().enumerate() {
        current.store(index, Ordering::SeqCst);
        if job.cancel_requested.load(Ordering::SeqCst) {
            status = JobStatus::Cancelled;
            break;
        }
        let offset = statement.offset;
        let _ = channel.send(ExecEvent::StatementStarted { index, offset });
        let at = Instant::now();
        let started_at = unix_millis();
        let tx_before = job.session.tx_status();
        let result = match &statement.params {
            Some(params) if !params.is_empty() => {
                job.session
                    .execute_params(&statement.sql, params, options)
                    .await
            }
            _ => job.session.execute(&statement.sql, options).await,
        };
        executed += 1;
        if job.session.tx_status() != tx_before {
            on_tx_change().await;
        }
        let elapsed_ms = millis(at);
        let mut record = HistoryRecord {
            console: job.key.console.clone(),
            sql: statement.sql.clone(),
            started_at,
            duration_ms: elapsed_ms,
            status: HistoryStatus::Ok,
            row_count: None,
            error: None,
            tx_mode,
        };
        match result {
            Ok(outcome) => {
                record.row_count = Some(match &outcome {
                    StatementOutcome::Rows { total_rows, .. } => *total_rows,
                    StatementOutcome::Command { rows_affected } => *rows_affected,
                });
                history.push(record);
                let _ = channel.send(ExecEvent::StatementDone {
                    index,
                    offset,
                    elapsed_ms,
                    outcome,
                });
            }
            Err(e) => {
                let cancelled = e.cancelled || job.cancel_requested.load(Ordering::SeqCst);
                tracing::debug!(
                    job = %job_id,
                    index,
                    sqlstate = e.sqlstate.as_deref().unwrap_or(""),
                    connection_lost = e.connection_lost,
                    "statement failed"
                );
                record.status = if cancelled {
                    HistoryStatus::Cancelled
                } else {
                    HistoryStatus::Error
                };
                record.error = Some(error_summary(&e.message));
                history.push(record);
                let _ = channel.send(ExecEvent::StatementFailed {
                    index,
                    offset,
                    elapsed_ms,
                    error: e.into(),
                });
                // Scripts stop at the first error, like running them through psql -v ON_ERROR_STOP.
                status = if cancelled {
                    JobStatus::Cancelled
                } else {
                    JobStatus::Failed
                };
                break;
            }
        }
    }
    job.session.set_notice_sink(None);
    Script {
        status,
        executed,
        history,
    }
}

/// Starts a job and returns its id at once; progress arrives on `on_event`.
#[tauri::command]
pub async fn query_execute(
    app: AppHandle,
    jobs: State<'_, Arc<Jobs>>,
    sessions: State<'_, Arc<Sessions>>,
    store: State<'_, Arc<Store>>,
    request: ExecRequest,
    on_event: Channel<ExecEvent>,
) -> Result<String, AppError> {
    let settings = crate::commands::with_store(&store, |s| s.settings()).await?;
    let timeout_ms = u64::from(settings.statement_timeout_secs) * 1000;
    let history = History {
        store: Arc::clone(store.inner()),
        retention: settings.history_retention(),
    };
    jobs.inner()
        .start(
            &app,
            sessions.inner(),
            request,
            timeout_ms,
            history,
            on_event,
        )
        .await
}

#[tauri::command]
pub async fn query_cancel(jobs: State<'_, Arc<Jobs>>, job_id: String) -> Result<(), AppError> {
    jobs.cancel(&job_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_json_uses_camel_case_fields() {
        let done = ExecEvent::StatementDone {
            index: 0,
            offset: 5,
            elapsed_ms: 7,
            outcome: StatementOutcome::Command { rows_affected: 1 },
        };
        assert_eq!(
            serde_json::to_value(&done).expect("encode"),
            serde_json::json!({ "event": "statementDone", "index": 0, "offset": 5, "elapsedMs": 7, "outcome": { "type": "command", "rowsAffected": 1 } })
        );
        let finished = ExecEvent::Finished {
            status: JobStatus::Cancelled,
            executed: 2,
            elapsed_ms: 9,
        };
        assert_eq!(
            serde_json::to_value(&finished).expect("encode"),
            serde_json::json!({ "event": "finished", "status": "cancelled", "executed": 2, "elapsedMs": 9 })
        );
        let failed = ExecEvent::StatementFailed {
            index: 1,
            offset: 0,
            elapsed_ms: 1,
            error: StatementError {
                message: "m".into(),
                detail: None,
                hint: None,
                sqlstate: Some("42601".into()),
                position: Some(3),
                cancelled: false,
                connection_lost: false,
            },
        };
        let notice = ExecEvent::Notice {
            index: 2,
            notice: Notice {
                severity: "NOTICE".into(),
                message: "hello".into(),
                detail: None,
                hint: None,
                sqlstate: "00000".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(&notice).expect("encode"),
            serde_json::json!({ "event": "notice", "index": 2, "notice": { "severity": "NOTICE", "message": "hello", "detail": null, "hint": null, "sqlstate": "00000" } })
        );
        let json = serde_json::to_value(&failed).expect("encode");
        assert_eq!(json["elapsedMs"], 1);
        assert_eq!(json["error"]["connectionLost"], false);
        assert_eq!(json["error"]["position"], 3);
    }

    // ---- History recording against the disposable server (`scripts/test-pg.sh up`) ----

    use std::time::Duration;

    use quarry_db_core::{ConnectParams, DatabaseAdapter, TlsMode};
    use quarry_db_postgres::PostgresAdapter;
    use quarry_secrets::SecretString;
    use quarry_store::{ConnectionDraft, Engine, Environment, HistoryQuery, SaveMode, SslMode};

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
            application_name: "quarry-it-history".into(),
            options: Default::default(),
        }
    }

    fn statement(sql: &str) -> StatementRequest {
        StatementRequest {
            sql: sql.into(),
            offset: 0,
            params: None,
        }
    }

    async fn job() -> Arc<Job> {
        let session = PostgresAdapter
            .connect(&params(), Box::new(|_| {}))
            .await
            .expect("connect");
        Arc::new(Job {
            key: SessionKey::shared("src"),
            session,
            cancel_requested: AtomicBool::new(false),
        })
    }

    async fn run(job: &Job, sql: &[&str]) -> Script {
        let statements: Vec<StatementRequest> = sql.iter().map(|s| statement(s)).collect();
        let channel = Channel::new(|_| Ok(()));
        run_statements(
            job,
            "test",
            &statements,
            &ExecOptions::default(),
            &channel,
            || async {},
        )
        .await
    }

    fn store(history_enabled: bool) -> Store {
        let store = Store::open_in_memory().expect("store");
        store
            .insert_connection(
                "src",
                ConnectionDraft {
                    name: "Test".into(),
                    engine: Engine::Postgres,
                    host: "127.0.0.1".into(),
                    port: 55432,
                    database: "quarry_test".into(),
                    username: "quarry".into(),
                    ssl_mode: SslMode::Disable,
                    connect_timeout_secs: 5,
                    read_only: false,
                    environment: Environment::Testing,
                    color: None,
                    save_mode: SaveMode::Never,
                    tx_mode: quarry_db_core::TxMode::Auto,
                    isolation: quarry_db_core::Isolation::ReadCommitted,
                    history_enabled,
                    ..Default::default()
                },
            )
            .expect("profile");
        store
    }

    const RETENTION: Retention = Retention {
        max_entries: 10_000,
        max_age_days: 0,
    };

    #[tokio::test]
    #[ignore = "needs scripts/test-pg.sh up"]
    async fn success_error_and_cancel_are_recorded_with_their_status() {
        let job = job().await;
        let store = store(true);

        // A script stops at its first error; the statements that ran are all recorded.
        let script = run(
            &job,
            &["select 1 union all select 2", "select nope", "select 3"],
        )
        .await;
        assert!(matches!(script.status, JobStatus::Failed));
        store
            .record_history("src", &script.history, RETENTION, unix_millis())
            .expect("record");

        let canceller = {
            let job = Arc::clone(&job);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(300)).await;
                job.cancel_requested.store(true, Ordering::SeqCst);
                job.session.cancel().await.expect("cancel");
            })
        };
        let script = run(&job, &["select pg_sleep(30)", "select 4"]).await;
        canceller.await.expect("canceller");
        assert!(matches!(script.status, JobStatus::Cancelled));
        store
            .record_history("src", &script.history, RETENTION, unix_millis())
            .expect("record");

        let entries = store
            .search_history(&HistoryQuery {
                connection_id: Some("src".into()),
                text: String::new(),
                limit: 10,
                offset: 0,
            })
            .expect("search");
        let seen: Vec<(&str, HistoryStatus, Option<u64>)> = entries
            .iter()
            .map(|e| (e.sql.as_str(), e.status, e.row_count))
            .collect();
        assert_eq!(
            seen,
            [
                ("select pg_sleep(30)", HistoryStatus::Cancelled, None),
                ("select nope", HistoryStatus::Error, None),
                ("select 1 union all select 2", HistoryStatus::Ok, Some(2)),
            ]
        );
        assert!(
            entries[1]
                .error
                .as_deref()
                .is_some_and(|e| e.contains("nope")),
            "{:?}",
            entries[1].error
        );
        assert!(entries[0].duration_ms >= 200, "{}", entries[0].duration_ms);
        job.session.close().await;
    }

    #[tokio::test]
    #[ignore = "needs scripts/test-pg.sh up"]
    async fn history_disabled_data_source_records_nothing() {
        let job = job().await;
        let store = store(false);
        let script = run(&job, &["select 1"]).await;
        assert_eq!(script.history.len(), 1);
        let written = store
            .record_history("src", &script.history, RETENTION, unix_millis())
            .expect("record");
        assert_eq!(written, 0);
        let entries = store
            .search_history(&HistoryQuery {
                connection_id: None,
                text: String::new(),
                limit: 10,
                offset: 0,
            })
            .expect("search");
        assert!(entries.is_empty());
        job.session.close().await;
    }
}
