//! PostgreSQL adapter (ADR-0002): tokio-postgres over rustls.

mod errors;
mod metadata;
mod tls;

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use quarry_db_core::{
    ConnectError, ConnectErrorKind, ConnectParams, DatabaseAdapter, DbError, MetaNode,
    MetadataRequest, OnClose, ServerInfo, Session, TlsMode,
};
use tokio::sync::{Mutex, RwLock};
use tokio::task::JoinHandle;
use tokio_postgres::Client;
use tokio_postgres::config::SslMode;
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
}

pub struct PgSession {
    /// `None` once closed. Calls hold a read guard, so `close` waits for in-flight queries.
    client: RwLock<Option<Client>>,
    info: ServerInfo,
    closed: Arc<AtomicBool>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl PgSession {
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

    async fn metadata(&self, request: &MetadataRequest) -> Result<Vec<MetaNode>, DbError> {
        self.with_client(async |client| metadata::load(client, request).await)
            .await
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

    // Resolve first so a bad host name is reported as DNS, not as a generic connect failure.
    let addresses = match tokio::time::timeout(
        deadline,
        tokio::net::lookup_host((params.host.as_str(), params.port)),
    )
    .await
    {
        Err(_) => return Err(errors::timeout(params, deadline)),
        Ok(Err(e)) => return Err(errors::dns(params, &e.to_string())),
        Ok(Ok(addrs)) => addrs.take(MAX_ADDRESSES).collect::<Vec<SocketAddr>>(),
    };
    if addresses.is_empty() {
        return Err(errors::dns(params, "no addresses"));
    }

    let mut config = tokio_postgres::Config::new();
    for addr in &addresses {
        // `host` stays the name (TLS server name); `hostaddr` skips a second lookup.
        config
            .host(&params.host)
            .hostaddr(addr.ip())
            .port(params.port);
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

    let tls = MakeRustlsConnect::new(tls::client_config(params.tls).map_err(errors::tls_setup)?);
    let remaining = deadline.saturating_sub(started.elapsed());
    let (client, connection) = match tokio::time::timeout(remaining, config.connect(tls)).await {
        Err(_) => return Err(errors::timeout(params, deadline)),
        Ok(Err(e)) => return Err(errors::classify(&e, params, params.password.is_some())),
        Ok(Ok(pair)) => pair,
    };

    let closed = Arc::new(AtomicBool::new(false));
    let task = {
        let closed = Arc::clone(&closed);
        tokio::spawn(async move {
            let result = connection.await;
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
    Ok(PgSession {
        client: RwLock::new(Some(client)),
        info,
        closed,
        task: Mutex::new(Some(task)),
    })
}
