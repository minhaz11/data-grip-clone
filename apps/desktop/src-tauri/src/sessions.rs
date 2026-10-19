//! Live database sessions (connect/disconnect) and their status events.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use quarry_db_core::{
    ConnectParams, DatabaseAdapter, MetaNode, MetadataRequest, ServerInfo, Session,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::AppError;

pub const STATUS_EVENT: &str = "connection-status";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
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
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub id: String,
    pub info: ServerInfo,
}

pub struct Sessions {
    adapter: Arc<dyn DatabaseAdapter>,
    live: tokio::sync::Mutex<HashMap<String, Arc<dyn Session>>>,
    connecting: Mutex<HashSet<String>>,
}

impl Sessions {
    pub fn new(adapter: Arc<dyn DatabaseAdapter>) -> Self {
        Self {
            adapter,
            live: Default::default(),
            connecting: Default::default(),
        }
    }

    pub async fn test(&self, params: &ConnectParams) -> Result<ServerInfo, AppError> {
        Ok(self.adapter.test(params).await?)
    }

    pub async fn connect(
        self: &Arc<Self>,
        app: &AppHandle,
        id: &str,
        params: &ConnectParams,
    ) -> Result<ServerInfo, AppError> {
        if let Some(s) = self.live.lock().await.get(id).filter(|s| !s.is_closed()) {
            return Ok(s.info().clone());
        }
        if !self
            .connecting
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.to_owned())
        {
            return Err(AppError::new(
                "busy",
                "This data source is already connecting.",
            ));
        }
        let result = self.adapter.connect(params, self.on_close(app, id)).await;
        self.connecting
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);

        let session = result?;
        let info = session.info().clone();
        let stale = self.live.lock().await.insert(id.to_owned(), session);
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
        Ok(info)
    }

    /// The open session for `id`, if any. The registry lock is released before the caller uses it.
    async fn get(&self, id: &str) -> Result<Arc<dyn Session>, AppError> {
        self.live
            .lock()
            .await
            .get(id)
            .filter(|s| !s.is_closed())
            .cloned()
            .ok_or_else(|| AppError::new("not_connected", "This data source is not connected."))
    }

    pub async fn metadata(
        &self,
        id: &str,
        request: &MetadataRequest,
    ) -> Result<Vec<MetaNode>, AppError> {
        Ok(self.get(id).await?.metadata(request).await?)
    }

    /// Closes a session if one is open. Idempotent.
    pub async fn disconnect(&self, id: &str) {
        let session = self.live.lock().await.remove(id);
        if let Some(s) = session {
            s.close().await; // on_close emits `Disconnected`
        }
    }

    pub async fn list(&self) -> Vec<SessionStatus> {
        self.live
            .lock()
            .await
            .iter()
            .filter(|(_, s)| !s.is_closed())
            .map(|(id, s)| SessionStatus {
                id: id.clone(),
                info: s.info().clone(),
            })
            .collect()
    }

    fn on_close(self: &Arc<Self>, app: &AppHandle, id: &str) -> quarry_db_core::OnClose {
        let (app, id, sessions) = (app.clone(), id.to_owned(), Arc::clone(self));
        Box::new(move |reason| {
            let event = match reason {
                Some(reason) => StatusEvent::Lost {
                    id: id.clone(),
                    reason,
                },
                None => StatusEvent::Disconnected { id: id.clone() },
            };
            let _ = app.emit(STATUS_EVENT, event);
            // Drop the dead entry (a deliberate disconnect already removed it).
            tauri::async_runtime::spawn(async move {
                let mut live = sessions.live.lock().await;
                if live.get(&id).is_some_and(|s| s.is_closed()) {
                    live.remove(&id);
                }
            });
        })
    }
}
