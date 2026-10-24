//! PostgreSQL adapter (ADR-0002): tokio-postgres over rustls.

mod ddl;
mod editability;
mod edits;
mod errors;
mod exec;
mod metadata;
mod refine;
mod schema_edit;
mod sqlutil;
mod tls;
mod txctl;

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use quarry_db_core::{
    Cell, ColumnInfo, ConnectError, ConnectErrorKind, ConnectParams, DatabaseAdapter, DbError,
    DdlObject, DdlOptions, EditStatement, EditTarget, ExecOptions, MetaNode, MetadataRequest,
    Notice, NoticeSink, ObjectDetails, ObjectRef, OnClose, Refinement, RowChange, SchemaChange,
    SchemaScope, ServerInfo, Session, StatementOutcome, TableModel, TlsMode, TxMode, TxSettings,
    TxStatus,
};
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;
use tokio_postgres::config::SslMode;
use tokio_postgres::{AsyncMessage, CancelToken, Client};
use tokio_postgres_rustls::MakeRustlsConnect;

/// Resolved addresses tried per host; libpq also tries every address a name resolves to.
const MAX_ADDRESSES: usize = 4;

#[derive(Default)]
pub struct PostgresAdapter;

#[async_trait::async_trait]
impl DatabaseAdapter for PostgresAdapter {
    async fn test(&self, params: &ConnectParams) -> Result<ServerInfo, ConnectError> {
        let session = open(params, None).await?;
        let info = session.info.clone();
        session.close().await;
        Ok(info)
    }

    async fn connect(
        &self,
        params: &ConnectParams,
        on_close: OnClose,
    ) -> Result<Arc<dyn Session>, ConnectError> {
        Ok(Arc::new(open(params, Some(on_close)).await?))
    }

    fn preview_schema(&self, change: &SchemaChange) -> Result<Vec<String>, DbError> {
        schema_edit::build(change).map_err(errors::invalid)
    }
}

/// Runs DDL `statements` in one transaction; the first failure rolls back and is named.
async fn schema_apply(client: &Client, statements: &[String]) -> Result<(), DbError> {
    let total = statements.len();
    client
        .batch_execute("BEGIN")
        .await
        .map_err(|e| errors::db_error(&e))?;
    for (i, sql) in statements.iter().enumerate() {
        if let Err(e) = client.batch_execute(sql).await {
            let _ = client.batch_execute("ROLLBACK").await;
            let mut err = errors::db_error(&e);
            err.message = format!("Statement {} of {total} failed: {}", i + 1, err.message);
            err.detail = Some(sql.clone());
            err.hint = Some("Nothing was changed.".into());
            return Err(err);
        }
    }
    client
        .batch_execute("COMMIT")
        .await
        .map_err(|e| errors::db_error(&e))
}

pub struct PgSession {
    /// `None` once closed. Calls hold a read guard, so `close` waits for in-flight queries.
    client: RwLock<Option<Client>>,
    info: ServerInfo,
    closed: Arc<AtomicBool>,
    task: Mutex<Option<JoinHandle<()>>>,
    /// Out-of-band cancel: opens a short connection with the session's own TLS settings.
    cancel_token: CancelToken,
    tls: MakeRustlsConnect,
    cursors: exec::Cursors,
    /// Kept to open the short-lived connection that applies edits, and for `fork`.
    params: ConnectParams,
    tx: std::sync::Mutex<TxState>,
    /// Where the connection task delivers notices (the running job), if anywhere.
    notices: Arc<std::sync::Mutex<Option<NoticeSink>>>,
    /// User statements running longer than this are cancelled; 0 = no limit. Enforced here
    /// rather than with `SET statement_timeout`, which PostgreSQL switches off before the
    /// commit that materializes a `WITH HOLD` cursor (where queries do their work).
    statement_timeout_ms: AtomicU64,
    /// Schemas `metadata` introspects; starts as the connect parameters' scope.
    scope: std::sync::Mutex<SchemaScope>,
}

#[derive(Default, Clone, Copy)]
struct TxState {
    status: TxStatus,
    settings: TxSettings,
}

/// Asks the server whether a transaction block is open. `tokio-postgres` does not expose the
/// ReadyForQuery status, so this uses a savepoint: it fails with 25P01 outside a block, 25P02 in
/// an aborted one, and succeeds (and is released) inside an open one.
async fn probe_tx(client: &Client) -> TxStatus {
    match client.batch_execute("SAVEPOINT quarry_tx_probe").await {
        Ok(()) => {
            let _ = client
                .batch_execute("RELEASE SAVEPOINT quarry_tx_probe")
                .await;
            TxStatus::Active
        }
        Err(e) if e.code().is_some_and(|c| c.code() == "25P02") => TxStatus::Failed,
        Err(_) => TxStatus::Idle,
    }
}

/// Whether the current transaction may write. Uses SHOW, which takes no snapshot: a SELECT here
/// would count as the transaction's first query and make a following `SET TRANSACTION` fail.
async fn transaction_writable(client: &Client) -> Result<bool, tokio_postgres::Error> {
    let value = client
        .simple_query("SHOW transaction_read_only")
        .await?
        .into_iter()
        .find_map(|m| match m {
            tokio_postgres::SimpleQueryMessage::Row(row) => row.get(0).map(str::to_owned),
            _ => None,
        });
    Ok(value.as_deref() == Some("off"))
}

/// Runs `statements` in one transaction; every update/delete must affect exactly one row.
async fn edits_apply(
    client: &Client,
    changes: &[RowChange],
    statements: &[EditStatement],
) -> Result<usize, DbError> {
    let total = statements.len();
    let fail = async |message: String, e: Option<&tokio_postgres::Error>| -> DbError {
        let _ = client.batch_execute("ROLLBACK").await;
        let mut err = e
            .map(errors::db_error)
            .unwrap_or_else(|| errors::invalid(String::new()));
        err.message = message;
        err.position = None;
        err.hint = Some("Nothing was saved. Refresh the result and try again.".into());
        err
    };
    client
        .batch_execute("BEGIN")
        .await
        .map_err(|e| errors::db_error(&e))?;
    for (i, (st, change)) in statements.iter().zip(changes).enumerate() {
        let what = match change {
            RowChange::Update { .. } => "update",
            RowChange::Delete { .. } => "delete",
            RowChange::Insert { .. } => "insert",
        };
        let binds: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = st
            .params
            .iter()
            .map(|p| p as &(dyn tokio_postgres::types::ToSql + Sync))
            .collect();
        match client.execute(&st.sql, &binds).await {
            Ok(1) => {}
            Ok(n) => {
                let why = if n == 0 {
                    "matched no row: it was changed or deleted since it was read"
                } else {
                    "matched more than one row"
                };
                return Err(
                    fail(format!("Change {} of {total} ({what}) {why}.", i + 1), None).await,
                );
            }
            Err(e) => {
                let msg = e
                    .as_db_error()
                    .map_or_else(|| e.to_string(), |d| d.message().to_owned());
                return Err(fail(
                    format!("Change {} of {total} ({what}) failed: {msg}", i + 1),
                    Some(&e),
                )
                .await);
            }
        }
    }
    client
        .batch_execute("COMMIT")
        .await
        .map_err(|e| errors::db_error(&e))?;
    Ok(total)
}

impl PgSession {
    fn tx(&self) -> TxState {
        *self.tx.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn set_tx_status(&self, status: TxStatus) {
        self.tx.lock().unwrap_or_else(|p| p.into_inner()).status = status;
    }

    /// Runs one user statement with the transaction rules of this session:
    /// - Manual mode opens a transaction before the first statement that needs one.
    /// - Read-only sources restore the read-only default before every statement outside a
    ///   transaction (`set_config()` inside any query could have switched it off), and roll back
    ///   a transaction that was switched to read-write.
    /// - The transaction state is re-read from the server whenever a statement could change it.
    async fn execute_in_tx(
        &self,
        client: &Client,
        sql: &str,
        params: &[Cell],
        options: &ExecOptions,
    ) -> Result<StatementOutcome, DbError> {
        let kind = txctl::kind(sql);
        let state = self.tx();
        let db = |e: tokio_postgres::Error| errors::db_error(&e);
        if state.status == TxStatus::Idle {
            if self.params.read_only {
                client
                    .batch_execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
                    .await
                    .map_err(db)?;
            }
            if state.settings.mode == TxMode::Manual
                && matches!(kind, txctl::Kind::Other | txctl::Kind::Procedural)
            {
                client
                    .batch_execute(&format!(
                        "BEGIN ISOLATION LEVEL {}",
                        state.settings.isolation.sql()
                    ))
                    .await
                    .map_err(db)?;
                self.set_tx_status(TxStatus::Active);
            }
        }

        let result = self.run_with_timeout(client, sql, params, options).await;

        if kind != txctl::Kind::Other || (result.is_err() && self.tx().status != TxStatus::Idle) {
            self.set_tx_status(probe_tx(client).await);
        }
        if self.params.read_only
            && self.tx().status == TxStatus::Active
            && (kind == txctl::Kind::Control || txctl::is_set(sql))
            && transaction_writable(client).await.unwrap_or(false)
        {
            let _ = client.batch_execute("ROLLBACK").await;
            self.set_tx_status(TxStatus::Idle);
            return Err(errors::read_only_violation());
        }
        result
    }

    /// `exec::run`, cancelled through the out-of-band cancel once the statement timeout passes.
    async fn run_with_timeout(
        &self,
        client: &Client,
        sql: &str,
        params: &[Cell],
        options: &ExecOptions,
    ) -> Result<StatementOutcome, DbError> {
        let ms = self.statement_timeout_ms.load(Ordering::Relaxed);
        let run = exec::run(client, &self.cursors, sql, params, options);
        if ms == 0 {
            return run.await.map_err(|e| errors::db_error(&e));
        }
        tokio::pin!(run);
        let result = tokio::select! {
            r = &mut run => return r.map_err(|e| errors::db_error(&e)),
            () = tokio::time::sleep(Duration::from_millis(ms)) => {
                let _ = self.cancel_token.cancel_query(self.tls.clone()).await;
                run.await
            }
        };
        result.map_err(|e| {
            let mut e = errors::db_error(&e);
            if e.sqlstate.as_deref() == Some("57014") {
                e.message = format!(
                    "Cancelled by the statement timeout after {}.",
                    if ms.is_multiple_of(1000) {
                        format!("{} s", ms / 1000)
                    } else {
                        format!("{ms} ms")
                    }
                );
                e.hint = Some("Change the limit in Settings (0 means no limit).".into());
                // Shown as an error with its reason, not as a user cancel.
                e.cancelled = false;
            }
            e
        })
    }

    async fn with_client<T>(
        &self,
        f: impl AsyncFnOnce(&Client) -> Result<T, tokio_postgres::Error>,
    ) -> Result<T, DbError> {
        let guard = self.client.read().await;
        let client = guard.as_ref().ok_or_else(errors::session_closed)?;
        f(client).await.map_err(|e| errors::db_error(&e))
    }
}

#[async_trait::async_trait]
impl Session for PgSession {
    fn info(&self) -> &ServerInfo {
        &self.info
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
            || self
                .client
                .try_read()
                .is_ok_and(|c| c.as_ref().is_none_or(Client::is_closed))
    }

    async fn execute(&self, sql: &str, options: &ExecOptions) -> Result<StatementOutcome, DbError> {
        let guard = self.client.read().await;
        let client = guard.as_ref().ok_or_else(errors::session_closed)?;
        self.execute_in_tx(client, sql, &[], options).await
    }

    async fn execute_params(
        &self,
        sql: &str,
        params: &[Cell],
        options: &ExecOptions,
    ) -> Result<StatementOutcome, DbError> {
        let guard = self.client.read().await;
        let client = guard.as_ref().ok_or_else(errors::session_closed)?;
        self.execute_in_tx(client, sql, params, options).await
    }

    fn set_notice_sink(&self, sink: Option<NoticeSink>) {
        *self.notices.lock().unwrap_or_else(|p| p.into_inner()) = sink;
    }

    async fn set_statement_timeout(&self, ms: u64) -> Result<(), DbError> {
        self.statement_timeout_ms.store(ms, Ordering::Relaxed);
        Ok(())
    }

    async fn fetch(
        &self,
        cursor: &str,
        offset: u64,
        limit: usize,
        options: &ExecOptions,
    ) -> Result<Vec<Vec<Cell>>, DbError> {
        if !self.cursors.is_open(cursor) {
            return Err(errors::unknown_cursor());
        }
        self.with_client(async |client| {
            exec::page(client, cursor, offset, limit, options.max_cell_chars)
                .await
                .map(|(_, rows)| rows)
        })
        .await
    }

    async fn refine(
        &self,
        base: &str,
        columns: &[ColumnInfo],
        refinement: &Refinement,
        options: &ExecOptions,
    ) -> Result<StatementOutcome, DbError> {
        let built = refine::build(base, columns, refinement).map_err(errors::invalid)?;
        self.with_client(async |client| {
            exec::run_refined(
                client,
                &self.cursors,
                &built.sql,
                &built.params,
                columns,
                options,
            )
            .await
        })
        .await
        // Positions would point into the generated wrapper, not the user's text.
        .map_err(|e| DbError {
            position: None,
            ..e
        })
    }

    fn preview_edits(
        &self,
        target: &EditTarget,
        changes: &[RowChange],
    ) -> Result<Vec<EditStatement>, DbError> {
        edits::build(target, changes).map_err(errors::invalid)
    }

    async fn apply_edits(
        &self,
        target: &EditTarget,
        changes: &[RowChange],
    ) -> Result<usize, DbError> {
        let statements = edits::build(target, changes).map_err(errors::invalid)?;
        // A separate connection: an open transaction in this session is never committed or
        // mixed in, and the edit transaction is isolated from the user's console.
        let side = open(&self.params, None).await.map_err(|e| {
            errors::invalid(format!(
                "Could not open a connection to apply the changes: {}",
                e.message
            ))
        })?;
        let result = side
            .with_client(async |client| Ok(edits_apply(client, changes, &statements).await))
            .await;
        side.close().await;
        result?
    }

    async fn close_cursor(&self, cursor: &str) -> Result<(), DbError> {
        if !self.cursors.forget(cursor) {
            return Ok(());
        }
        self.with_client(async |client| client.batch_execute(&format!("CLOSE {cursor}")).await)
            .await
    }

    async fn cancel(&self) -> Result<(), DbError> {
        self.cancel_token
            .cancel_query(self.tls.clone())
            .await
            .map_err(|e| errors::db_error(&e))
    }

    async fn metadata(&self, request: &MetadataRequest) -> Result<Vec<MetaNode>, DbError> {
        let scope = self.scope.lock().unwrap_or_else(|p| p.into_inner()).clone();
        self.with_client(async |client| metadata::load(client, request, &scope).await)
            .await
    }

    fn set_schema_scope(&self, scope: SchemaScope) {
        *self.scope.lock().unwrap_or_else(|p| p.into_inner()) = scope;
    }

    async fn object_details(&self, object: &ObjectRef) -> Result<Option<ObjectDetails>, DbError> {
        self.with_client(async |client| metadata::details(client, object).await)
            .await
    }

    async fn table_model(&self, schema: &str, name: &str) -> Result<Option<TableModel>, DbError> {
        self.with_client(async |client| schema_edit::load_model(client, schema, name).await)
            .await
    }

    async fn apply_schema(&self, statements: &[String]) -> Result<(), DbError> {
        if statements.is_empty() {
            return Ok(());
        }
        // Like row edits: a separate connection, so an open console transaction is never
        // committed or mixed in.
        let side = open(&self.params, None).await.map_err(|e| {
            errors::invalid(format!(
                "Could not open a connection to apply the changes: {}",
                e.message
            ))
        })?;
        let result = side
            .with_client(async |client| Ok(schema_apply(client, statements).await))
            .await;
        side.close().await;
        result?
    }

    async fn ddl(&self, objects: &[DdlObject], options: &DdlOptions) -> Result<String, DbError> {
        // Its own connection: generation changes search_path, and must not touch this
        // session's transaction or settings.
        let side = open(&self.params, None).await.map_err(|e| {
            errors::invalid(format!(
                "Could not open a connection to generate DDL: {}",
                e.message
            ))
        })?;
        let result = side
            .with_client(async |client| Ok(ddl::generate(client, objects, options).await))
            .await;
        side.close().await;
        match result? {
            Ok(script) => Ok(script),
            Err(ddl::DdlError::Db(e)) => Err(errors::db_error(&e)),
            Err(ddl::DdlError::Missing(what)) => Err(errors::invalid(format!(
                "{what} does not exist (any more). Refresh the explorer."
            ))),
        }
    }

    fn tx_status(&self) -> TxStatus {
        self.tx().status
    }

    fn tx_settings(&self) -> TxSettings {
        self.tx().settings
    }

    fn set_tx_settings(&self, settings: TxSettings) {
        self.tx.lock().unwrap_or_else(|p| p.into_inner()).settings = settings;
    }

    async fn commit(&self) -> Result<TxStatus, DbError> {
        let before = self.tx().status;
        let status = self
            .with_client(async |client| {
                if before != TxStatus::Idle {
                    // On a failed transaction the server answers COMMIT with a rollback.
                    client.batch_execute("COMMIT").await?;
                }
                Ok(probe_tx(client).await)
            })
            .await?;
        self.set_tx_status(status);
        if before == TxStatus::Failed {
            return Err(errors::invalid(
                "The transaction had failed, so the server rolled it back instead of committing."
                    .into(),
            ));
        }
        Ok(status)
    }

    async fn rollback(&self) -> Result<TxStatus, DbError> {
        let status = self
            .with_client(async |client| {
                client.batch_execute("ROLLBACK").await?;
                Ok(probe_tx(client).await)
            })
            .await?;
        self.set_tx_status(status);
        Ok(status)
    }

    async fn set_schema(&self, schema: Option<&str>) -> Result<(), DbError> {
        self.with_client(async |client| match schema {
            // quote_ident on the server, so any schema name is safe and exact.
            Some(schema) => client
                .execute(
                    "SELECT set_config('search_path', quote_ident($1) || ', ' || reset_val, false)
                       FROM pg_settings WHERE name = 'search_path'",
                    &[&schema],
                )
                .await
                .map(|_| ()),
            None => client.batch_execute("RESET search_path").await,
        })
        .await
    }

    fn abort(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // Aborting the connection task drops the socket; waiting client calls then fail.
        if let Ok(mut task) = self.task.try_lock()
            && let Some(task) = task.take()
        {
            task.abort();
        }
    }

    async fn fork(&self, on_close: OnClose) -> Result<Arc<dyn Session>, ConnectError> {
        Ok(Arc::new(open(&self.params, Some(on_close)).await?))
    }

    async fn close(&self) {
        // Mark first so the connection task reports a deliberate close, not a failure.
        self.closed.store(true, Ordering::SeqCst);
        // Dropping the client makes the connection send Terminate and finish cleanly.
        drop(self.client.write().await.take());
        if let Some(task) = self.task.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
    }
}

async fn open(
    params: &ConnectParams,
    on_close: Option<OnClose>,
) -> Result<PgSession, ConnectError> {
    let started = Instant::now();
    let deadline = params.connect_timeout;

    let addresses = match params.options.dial {
        // A tunnel's local end: nothing to resolve.
        Some(addr) => vec![addr],
        // Resolve first so a bad host name is reported as DNS, not as a generic connect failure.
        None => match tokio::time::timeout(
            deadline,
            tokio::net::lookup_host((params.host.as_str(), params.port)),
        )
        .await
        {
            Err(_) => return Err(errors::timeout(params, deadline)),
            Ok(Err(e)) => return Err(errors::dns(params, &e.to_string())),
            Ok(Ok(addrs)) => addrs.take(MAX_ADDRESSES).collect::<Vec<SocketAddr>>(),
        },
    };
    if addresses.is_empty() {
        return Err(errors::dns(params, "no addresses"));
    }

    let mut config = tokio_postgres::Config::new();
    for addr in &addresses {
        // `host` stays the name (TLS server name); `hostaddr` skips a second lookup. The cancel
        // token keeps these too, so a cancel goes through a tunnel like the session does.
        config
            .host(&params.host)
            .hostaddr(addr.ip())
            .port(addr.port());
    }
    config
        .user(&params.username)
        .dbname(if params.database.is_empty() {
            &params.username
        } else {
            &params.database
        })
        .application_name(&params.application_name)
        .connect_timeout(deadline)
        .ssl_mode(match params.tls {
            TlsMode::Disable => SslMode::Disable,
            TlsMode::Prefer => SslMode::Prefer,
            TlsMode::Require | TlsMode::VerifyCa | TlsMode::VerifyFull => SslMode::Require,
        });
    if let Some(pw) = &params.password {
        config.password(pw.expose());
    }
    if params.read_only {
        config.options("-c default_transaction_read_only=on");
    }
    if let Some(idle) = params.options.keepalive {
        config.keepalives(true).keepalives_idle(idle);
    }

    let tls = MakeRustlsConnect::new(
        tls::client_config(params.tls, &params.options.tls_files).map_err(errors::tls_setup)?,
    );
    let remaining = deadline.saturating_sub(started.elapsed());
    let (client, connection) =
        match tokio::time::timeout(remaining, config.connect(tls.clone())).await {
            Err(_) => return Err(errors::timeout(params, deadline)),
            Ok(Err(e)) => return Err(errors::classify(&e, params, params.password.is_some())),
            Ok(Ok(pair)) => pair,
        };

    let closed = Arc::new(AtomicBool::new(false));
    let notices: Arc<std::sync::Mutex<Option<NoticeSink>>> = Arc::default();
    let task = {
        let closed = Arc::clone(&closed);
        let notices = Arc::clone(&notices);
        let mut connection = connection;
        tokio::spawn(async move {
            // Driving the connection by messages (rather than awaiting it) surfaces notices,
            // which are handed to the current sink in the order the server sent them.
            let result = loop {
                match std::future::poll_fn(|cx| connection.poll_message(cx)).await {
                    Some(Ok(AsyncMessage::Notice(n))) => {
                        let sink = notices.lock().unwrap_or_else(|p| p.into_inner()).clone();
                        if let Some(sink) = sink {
                            sink(Notice {
                                severity: n.severity().to_owned(),
                                message: n.message().to_owned(),
                                detail: n.detail().map(str::to_owned),
                                hint: n.hint().map(str::to_owned),
                                sqlstate: n.code().code().to_owned(),
                            });
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break Err(e),
                    None => break Ok(()),
                }
            };
            let deliberate = closed.swap(true, Ordering::SeqCst);
            if let Some(cb) = on_close {
                cb(match result {
                    Err(e) if !deliberate => Some(e.to_string()),
                    _ => None,
                });
            }
        })
    };

    let probe = client
        .query_one(
            "SELECT version(), current_setting('server_version'), current_database(), current_user::text,
                    COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false),
                    current_setting('default_transaction_read_only') = 'on'",
            &[],
        )
        .await;
    let row = match probe {
        Ok(row) => row,
        Err(e) => {
            closed.store(true, Ordering::SeqCst);
            drop(client);
            task.abort();
            return Err(ConnectError {
                kind: ConnectErrorKind::Other,
                message: format!("Connected, but the server probe failed: {e}."),
                hint: "The server may not be PostgreSQL-compatible.".into(),
                sqlstate: e.code().map(|c| c.code().to_owned()),
            });
        }
    };

    let info = ServerInfo {
        version: row.get(0),
        server_version: row.get(1),
        database: row.get(2),
        user: row.get(3),
        tls: row.get(4),
        read_only: row.get(5),
        latency_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    };
    let startup = params.options.startup_sql.trim();
    if !startup.is_empty()
        && let Err(e) = client.batch_execute(startup).await
    {
        closed.store(true, Ordering::SeqCst);
        drop(client);
        task.abort();
        let db = errors::db_error(&e);
        return Err(ConnectError {
            kind: ConnectErrorKind::Other,
            message: format!("Connected, but the startup SQL failed: {}", db.message),
            hint: "Fix the startup SQL on the Options tab, or clear it.".into(),
            sqlstate: db.sqlstate,
        });
    }
    Ok(PgSession {
        cancel_token: client.cancel_token(),
        tls,
        cursors: exec::Cursors::default(),
        params: params.clone(),
        tx: std::sync::Mutex::new(TxState::default()),
        notices,
        statement_timeout_ms: AtomicU64::new(0),
        scope: std::sync::Mutex::new(params.options.schema_scope.clone()),
        client: RwLock::new(Some(client)),
        info,
        closed,
        task: Mutex::new(Some(task)),
    })
}
