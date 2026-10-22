//! Query jobs: a script runs statement by statement on the data source's session, streaming
//! progress to the console that started it through a Tauri `Channel`.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use quarry_db_core::{DbError, ExecOptions, Session, StatementOutcome};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri::ipc::Channel;
use tokio::sync::Mutex;

use crate::error::AppError;
use crate::sessions::Sessions;

pub const MAX_STATEMENTS: usize = 1_000;
const MAX_ROWS_LIMIT: usize = 10_000;

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StatementRequest {
    pub sql: String,
    /// Where the statement starts in the console text; echoed back so the UI can map positions.
    pub offset: u32,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    pub source_id: String,
    pub statements: Vec<StatementRequest>,
    #[cfg_attr(test, ts(optional))]
    pub max_rows: Option<usize>,
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
    Finished {
        status: JobStatus,
        executed: usize,
        elapsed_ms: u64,
    },
}

struct Job {
    source_id: String,
    session: Arc<dyn Session>,
    cancel_requested: AtomicBool,
}

#[derive(Default)]
pub struct Jobs {
    running: Mutex<HashMap<String, Arc<Job>>>,
}

fn millis(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
}

impl Jobs {
    async fn start(
        self: &Arc<Self>,
        sessions: &Sessions,
        request: ExecRequest,
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
        let session = sessions.get(&request.source_id).await?;
        let job_id = uuid::Uuid::new_v4().to_string();
        {
            let mut running = self.running.lock().await;
            // One job per session: a server-side cancel stops whatever the session is running.
            if running.values().any(|j| j.source_id == request.source_id) {
                return Err(AppError::new(
                    "busy",
                    "A query is already running on this data source. Stop it first.",
                ));
            }
            running.insert(
                job_id.clone(),
                Arc::new(Job {
                    source_id: request.source_id.clone(),
                    session,
                    cancel_requested: AtomicBool::new(false),
                }),
            );
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
            source = %request.source_id,
            statements = request.statements.len(),
            "query job started"
        );
        let jobs = Arc::clone(self);
        let id = job_id.clone();
        tauri::async_runtime::spawn(async move {
            jobs.run(&id, request.statements, options, channel).await;
            jobs.running.lock().await.remove(&id);
        });
        Ok(job_id)
    }

    async fn run(
        &self,
        job_id: &str,
        statements: Vec<StatementRequest>,
        options: ExecOptions,
        channel: Channel<ExecEvent>,
    ) {
        let Some(job) = self.running.lock().await.get(job_id).cloned() else {
            return;
        };
        let started = Instant::now();
        let mut status = JobStatus::Completed;
        let mut executed = 0;
        for (index, statement) in statements.iter().enumerate() {
            if job.cancel_requested.load(Ordering::SeqCst) {
                status = JobStatus::Cancelled;
                break;
            }
            let offset = statement.offset;
            let _ = channel.send(ExecEvent::StatementStarted { index, offset });
            let at = Instant::now();
            let result = job.session.execute(&statement.sql, &options).await;
            executed += 1;
            match result {
                Ok(outcome) => {
                    let _ = channel.send(ExecEvent::StatementDone {
                        index,
                        offset,
                        elapsed_ms: millis(at),
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
                    let _ = channel.send(ExecEvent::StatementFailed {
                        index,
                        offset,
                        elapsed_ms: millis(at),
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
        let elapsed_ms = millis(started);
        tracing::info!(job = %job_id, ?status, executed, elapsed_ms, "query job finished");
        let _ = channel.send(ExecEvent::Finished {
            status,
            executed,
            elapsed_ms,
        });
    }

    async fn cancel(&self, job_id: &str) -> Result<(), AppError> {
        let job = self.running.lock().await.get(job_id).cloned();
        let Some(job) = job else { return Ok(()) }; // already finished
        job.cancel_requested.store(true, Ordering::SeqCst);
        tracing::info!(job = %job_id, "cancel requested");
        job.session.cancel().await.map_err(AppError::from)
    }
}

/// Starts a job and returns its id at once; progress arrives on `on_event`.
#[tauri::command]
pub async fn query_execute(
    jobs: State<'_, Arc<Jobs>>,
    sessions: State<'_, Arc<Sessions>>,
    request: ExecRequest,
    on_event: Channel<ExecEvent>,
) -> Result<String, AppError> {
    jobs.inner().start(&sessions, request, on_event).await
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
        let json = serde_json::to_value(&failed).expect("encode");
        assert_eq!(json["elapsedMs"], 1);
        assert_eq!(json["error"]["connectionLost"], false);
        assert_eq!(json["error"]["position"], 3);
    }
}
