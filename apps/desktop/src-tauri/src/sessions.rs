//! Live database sessions and their status events. Each data source has one shared session
//! (opened by Connect); a console can ask for its own session with its own transaction, forked from
//! the shared one on first use.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use quarry_db_core::{
    ConnectParams, DatabaseAdapter, MetaNode, MetadataRequest, ServerInfo, Session, TxSettings,
    TxStatus,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::AppError;

pub const STATUS_EVENT: &str = "connection-status";
pub const SESSION_STATE_EVENT: &str = "session-state";

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state"
)]
pub enum StatusEvent {
    Connected {
        id: String,
        info: ServerInfo,
    },
    /// Closed on request.
    Disconnected {
        id: String,
    },
    /// Dropped by the server or network.
    Lost {
        id: String,
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub id: String,
    pub info: ServerInfo,
}

/// Which session: the data source's shared one, or a console's own.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionKey {
    pub source_id: String,
    /// Console name for a console's own session; absent for the shared one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub console: Option<String>,
}

impl SessionKey {
    pub fn shared(source_id: &str) -> Self {
        Self {
            source_id: source_id.to_owned(),
            console: None,
        }
    }
}

/// A session's transaction state, sent as `session-state` events whenever it changes.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub session: SessionKey,
    pub open: bool,
    pub status: TxStatus,
    pub settings: TxSettings,
}

pub struct Sessions {
    adapter: Arc<dyn DatabaseAdapter>,
    live: tokio::sync::Mutex<HashMap<SessionKey, Arc<dyn Session>>>,
    connecting: Mutex<HashSet<String>>,
    /// Transaction settings chosen for a session; kept across reconnects.
    chosen: Mutex<HashMap<SessionKey, TxSettings>>,
    /// Each data source's default settings (from its profile), recorded at connect.
    defaults: Mutex<HashMap<String, TxSettings>>,
    /// The schema this app last put first in each live session's search path.
    schemas: Mutex<HashMap<SessionKey, Option<String>>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Sessions {
    pub fn new(adapter: Arc<dyn DatabaseAdapter>) -> Self {
        Self {
            adapter,
            live: Default::default(),
            connecting: Default::default(),
            chosen: Default::default(),
            defaults: Default::default(),
            schemas: Default::default(),
        }
    }

    pub async fn test(&self, params: &ConnectParams) -> Result<ServerInfo, AppError> {
        Ok(self.adapter.test(params).await?)
    }

    /// The statements a schema change would run (no connection needed).
    pub fn preview_schema(
        &self,
        change: &quarry_db_core::SchemaChange,
    ) -> Result<Vec<String>, AppError> {
        Ok(self.adapter.preview_schema(change)?)
    }

    fn settings_for(&self, key: &SessionKey) -> TxSettings {
        lock(&self.chosen)
            .get(key)
            .copied()
            .or_else(|| lock(&self.defaults).get(&key.source_id).copied())
            .unwrap_or_default()
    }

    /// Opens the shared session of data source `id`; `defaults` are its profile's settings.
    pub async fn connect(
        self: &Arc<Self>,
        app: &AppHandle,
        id: &str,
        params: &ConnectParams,
        defaults: TxSettings,
    ) -> Result<ServerInfo, AppError> {
        let key = SessionKey::shared(id);
        if let Some(s) = self.live.lock().await.get(&key).filter(|s| !s.is_closed()) {
            return Ok(s.info().clone());
        }
        if !lock(&self.connecting).insert(id.to_owned()) {
            return Err(AppError::new(
                "busy",
                "This data source is already connecting.",
            ));
        }
        let result = self.adapter.connect(params, self.on_close(app, &key)).await;
        lock(&self.connecting).remove(id);

        let session = match result {
            Ok(session) => session,
            Err(e) => {
                tracing::warn!(source = %id, kind = ?e.kind, "connect failed");
                return Err(e.into());
            }
        };
        let info = session.info().clone();
        tracing::info!(
            source = %id,
            server_version = %info.server_version,
            tls = info.tls,
            read_only = info.read_only,
            latency_ms = info.latency_ms,
            "connected"
        );
        lock(&self.defaults).insert(id.to_owned(), defaults);
        session.set_tx_settings(self.settings_for(&key));
        lock(&self.schemas).remove(&key);
        let stale = self.live.lock().await.insert(key.clone(), session);
        if let Some(stale) = stale {
            stale.close().await;
        }
        let _ = app.emit(
            STATUS_EVENT,
            StatusEvent::Connected {
                id: id.to_owned(),
                info: info.clone(),
            },
        );
        self.emit_state(app, &key).await;
        Ok(info)
    }

    /// The open session for `key`, if any. The registry lock is released before the caller uses
    /// it.
    pub async fn get(&self, key: &SessionKey) -> Result<Arc<dyn Session>, AppError> {
        self.live
            .lock()
            .await
            .get(key)
            .filter(|s| !s.is_closed())
            .cloned()
            .ok_or_else(|| match key.console {
                None => AppError::new("not_connected", "This data source is not connected."),
                Some(_) => AppError::new(
                    "not_connected",
                    "This console's session is closed. Run a statement to open it again.",
                ),
            })
    }

    /// Like [`get`](Self::get), but opens a console's own session on first use (the shared
    /// session must be connected).
    pub async fn get_or_open(
        self: &Arc<Self>,
        app: &AppHandle,
        key: &SessionKey,
    ) -> Result<Arc<dyn Session>, AppError> {
        if key.console.is_none() {
            return self.get(key).await;
        }
        if let Ok(session) = self.get(key).await {
            return Ok(session);
        }
        let shared = self.get(&SessionKey::shared(&key.source_id)).await?;
        let session = shared.fork(self.on_close(app, key)).await?;
        session.set_tx_settings(self.settings_for(key));
        lock(&self.schemas).remove(key);
        tracing::info!(source = %key.source_id, console = ?key.console, "console session opened");
        let stale = self.live.lock().await.insert(key.clone(), session.clone());
        if let Some(stale) = stale {
            stale.close().await;
        }
        self.emit_state(app, key).await;
        Ok(session)
    }

    /// Puts `schema` first in `key`'s search path (or restores the default), unless that is
    /// already what this app last applied. A `SET search_path` the user ran stays in effect until
    /// the console's choice changes.
    pub async fn apply_schema(
        &self,
        key: &SessionKey,
        session: &Arc<dyn Session>,
        schema: Option<&str>,
    ) -> Result<(), AppError> {
        let current = lock(&self.schemas).get(key).cloned().flatten();
        if current.as_deref() == schema {
            return Ok(());
        }
        session.set_schema(schema).await?;
        lock(&self.schemas).insert(key.clone(), schema.map(str::to_owned));
        Ok(())
    }

    pub async fn state(&self, key: &SessionKey) -> SessionState {
        match self.get(key).await {
            Ok(session) => SessionState {
                session: key.clone(),
                open: true,
                status: session.tx_status(),
                settings: session.tx_settings(),
            },
            Err(_) => SessionState {
                session: key.clone(),
                open: false,
                status: TxStatus::Idle,
                settings: self.settings_for(key),
            },
        }
    }

    pub async fn emit_state(&self, app: &AppHandle, key: &SessionKey) {
        let _ = app.emit(SESSION_STATE_EVENT, self.state(key).await);
    }

    /// Remembers `settings` for `key` and applies them to its session if it is open.
    pub async fn set_tx_settings(
        &self,
        app: &AppHandle,
        key: &SessionKey,
        settings: TxSettings,
    ) -> SessionState {
        lock(&self.chosen).insert(key.clone(), settings);
        if let Ok(session) = self.get(key).await {
            session.set_tx_settings(settings);
        }
        self.emit_state(app, key).await;
        self.state(key).await
    }

    pub async fn commit(
        &self,
        app: &AppHandle,
        key: &SessionKey,
    ) -> Result<SessionState, AppError> {
        let session = self.get(key).await?;
        let result = session.commit().await;
        tracing::info!(source = %key.source_id, console = ?key.console, ok = result.is_ok(), "commit");
        self.emit_state(app, key).await;
        result?;
        Ok(self.state(key).await)
    }

    pub async fn rollback(
        &self,
        app: &AppHandle,
        key: &SessionKey,
    ) -> Result<SessionState, AppError> {
        let session = self.get(key).await?;
        let result = session.rollback().await;
        tracing::info!(source = %key.source_id, console = ?key.console, ok = result.is_ok(), "rollback");
        self.emit_state(app, key).await;
        result?;
        Ok(self.state(key).await)
    }

    /// Sessions with an open or failed transaction.
    pub fn open_transactions(&self) -> Vec<SessionKey> {
        // Called from the window-close handler (not async); a busy registry counts as none.
        let Ok(live) = self.live.try_lock() else {
            return Vec::new();
        };
        live.iter()
            .filter(|(_, s)| !s.is_closed() && s.tx_status() != TxStatus::Idle)
            .map(|(k, _)| k.clone())
            .collect()
    }

    /// Closes a console's own session. The shared session is closed with `disconnect`.
    pub async fn close_console(&self, key: &SessionKey) -> Result<(), AppError> {
        if key.console.is_none() {
            return Err(AppError::new(
                "invalid",
                "Use Disconnect to close a data source's shared session.",
            ));
        }
        let session = self.live.lock().await.remove(key);
        lock(&self.schemas).remove(key);
        if let Some(s) = session {
            s.close().await; // on_close emits the closed state
        }
        Ok(())
    }

    /// Drops `key`'s connection at once, even while a statement runs (second-stage cancel).
    pub async fn drop_session(&self, app: &AppHandle, key: &SessionKey) {
        let session = self.live.lock().await.remove(key);
        lock(&self.schemas).remove(key);
        let Some(session) = session else { return };
        session.abort();
        tracing::warn!(source = %key.source_id, console = ?key.console, "session dropped");
        // An aborted connection never reports its close; say it here.
        if key.console.is_none() {
            let _ = app.emit(
                STATUS_EVENT,
                StatusEvent::Lost {
                    id: key.source_id.clone(),
                    reason: "The connection was dropped while a statement was running.".into(),
                },
            );
        }
        self.emit_state(app, key).await;
    }

    pub async fn metadata(
        &self,
        id: &str,
        request: &MetadataRequest,
    ) -> Result<Vec<MetaNode>, AppError> {
        Ok(self
            .get(&SessionKey::shared(id))
            .await?
            .metadata(request)
            .await?)
    }

    /// Closes every session of data source `id`. Idempotent.
    pub async fn disconnect(&self, id: &str) {
        let sessions: Vec<_> = {
            let mut live = self.live.lock().await;
            let keys: Vec<SessionKey> =
                live.keys().filter(|k| k.source_id == id).cloned().collect();
            keys.into_iter()
                .filter_map(|k| live.remove(&k).map(|s| (k, s)))
                .collect()
        };
        for (key, session) in sessions {
            lock(&self.schemas).remove(&key);
            session.close().await; // on_close emits `Disconnected` / the closed state
        }
    }

    /// Shared sessions, for the connection status shown in the explorer.
    pub async fn list(&self) -> Vec<SessionStatus> {
        self.live
            .lock()
            .await
            .iter()
            .filter(|(k, s)| k.console.is_none() && !s.is_closed())
            .map(|(k, s)| SessionStatus {
                id: k.source_id.clone(),
                info: s.info().clone(),
            })
            .collect()
    }

    fn on_close(self: &Arc<Self>, app: &AppHandle, key: &SessionKey) -> quarry_db_core::OnClose {
        let (app, key, sessions) = (app.clone(), key.clone(), Arc::clone(self));
        Box::new(move |reason| {
            if key.console.is_none() {
                let id = key.source_id.clone();
                let event = match reason {
                    Some(reason) => {
                        tracing::warn!(source = %id, reason = %reason, "connection lost");
                        StatusEvent::Lost { id, reason }
                    }
                    None => {
                        tracing::info!(source = %id, "disconnected");
                        StatusEvent::Disconnected { id }
                    }
                };
                let _ = app.emit(STATUS_EVENT, event);
            } else if let Some(reason) = reason {
                tracing::warn!(source = %key.source_id, console = ?key.console, reason = %reason, "console session lost");
            }
            // Drop the dead entry (a deliberate close already removed it) and report the state.
            tauri::async_runtime::spawn(async move {
                {
                    let mut live = sessions.live.lock().await;
                    if live.get(&key).is_some_and(|s| s.is_closed()) {
                        live.remove(&key);
                    }
                }
                sessions.emit_state(&app, &key).await;
            });
        })
    }
}
