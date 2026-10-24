//! AI provider and settings (M6.1, ADR-0005). The API key goes into the OS keyring through a
//! write-only command and is never read back over IPC. The kill switch is enforced here, in Rust:
//! while AI is off (globally or for this workspace) no request is built, the key is not even read,
//! and the model list comes from the built-in fallback.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::StreamExt;
use quarry_ai_anthropic::{AnthropicProvider, Options};
use quarry_ai_core::{
    AiError, AiEvent, AiProvider, CompletionRequest, KillSwitch, Message, ModelInfo, StopReason,
    Switched, Usage,
};
use quarry_secrets::{CredentialStore, SecretString};
use quarry_store::{AiSettings, Store};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Channel;

use crate::error::AppError;

/// Keyring account of the Anthropic API key (ADR-0003).
pub const KEY_ACCOUNT: &str = "ai:anthropic:api-key";
/// The app has one workspace for now; per-workspace switches are keyed by this id.
pub const WORKSPACE_ID: &str = "main";
const MAX_KEY_LEN: usize = 512;

/// What Settings > AI shows. Says whether a key is stored, never what it is.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub settings: AiSettings,
    pub key_stored: bool,
    pub workspace_id: String,
    /// AI is enabled and not turned off for this workspace: requests may be sent.
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiModels {
    pub models: Vec<ModelInfo>,
    /// The list came from the provider (not the built-in fallback).
    pub live: bool,
    /// Why the live list could not be read, when that was tried.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub error: Option<String>,
}

/// Events of one streamed request, sent through its channel.
#[derive(Debug, Serialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AiStreamEvent {
    Started {
        model: String,
    },
    Text {
        text: String,
    },
    Done {
        stop_reason: Option<StopReason>,
        usage: Usage,
    },
    Failed {
        error: AppError,
    },
}

impl From<AiEvent> for AiStreamEvent {
    fn from(event: AiEvent) -> Self {
        match event {
            AiEvent::Started { model } => Self::Started { model },
            AiEvent::Text { text } => Self::Text { text },
            AiEvent::Done { stop_reason, usage } => Self::Done { stop_reason, usage },
        }
    }
}

pub struct Ai {
    store: Arc<Store>,
    keyring: Arc<dyn CredentialStore>,
    switch: Arc<KillSwitch>,
    options: Options,
    running: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn validate_key(key: &SecretString) -> Result<(), AppError> {
    let value = key.expose();
    if value.is_empty() {
        return Err(AppError::new("invalid", "Enter an API key."));
    }
    if value.len() > MAX_KEY_LEN || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::new(
            "invalid",
            "That does not look like an API key: it contains spaces or is too long.",
        ));
    }
    Ok(())
}

impl Ai {
    pub fn new(
        store: Arc<Store>,
        keyring: Arc<dyn CredentialStore>,
        options: Options,
    ) -> Result<Self, AppError> {
        let switch = Arc::new(KillSwitch::default());
        switch.set_allowed(store.ai_settings()?.active_in(WORKSPACE_ID));
        Ok(Self {
            store,
            keyring,
            switch,
            options,
            running: Mutex::new(HashMap::new()),
        })
    }

    fn secret_error(e: quarry_secrets::SecretError) -> AppError {
        AppError::new("credential_store", e.to_string())
    }

    /// Blocking: reads the keyring.
    pub fn status(&self) -> Result<AiStatus, AppError> {
        let settings = self.store.ai_settings()?;
        let key_stored = self
            .keyring
            .get(KEY_ACCOUNT)
            .map_err(Self::secret_error)?
            .is_some();
        Ok(AiStatus {
            active: settings.active_in(WORKSPACE_ID),
            settings,
            key_stored,
            workspace_id: WORKSPACE_ID.into(),
        })
    }

    /// Blocking. Turning AI off takes effect before this returns: running requests are stopped.
    pub fn set_settings(&self, settings: &AiSettings) -> Result<AiStatus, AppError> {
        let saved = self.store.set_ai_settings(settings)?;
        let active = saved.active_in(WORKSPACE_ID);
        self.switch.set_allowed(active);
        if !active {
            self.cancel_all();
        }
        tracing::info!(enabled = saved.enabled, active, model = %saved.model, ignore = saved.ignore.len(), "AI settings saved");
        self.status()
    }

    /// Blocking. Write-only: the key can be replaced or removed, never read back.
    pub fn set_key(&self, key: &SecretString) -> Result<AiStatus, AppError> {
        validate_key(key)?;
        self.keyring
            .set(KEY_ACCOUNT, key)
            .map_err(Self::secret_error)?;
        tracing::info!("AI API key stored in the credential store");
        self.status()
    }

    /// Blocking.
    pub fn clear_key(&self) -> Result<AiStatus, AppError> {
        self.cancel_all();
        self.keyring
            .delete(KEY_ACCOUNT)
            .map_err(Self::secret_error)?;
        tracing::info!("AI API key removed from the credential store");
        self.status()
    }

    /// Blocking. The provider for the next request; the switch is checked before the key is read.
    fn provider(&self) -> Result<Switched<AnthropicProvider>, AppError> {
        self.switch.check()?;
        let key = self
            .keyring
            .get(KEY_ACCOUNT)
            .map_err(Self::secret_error)?
            .ok_or(AiError::NoKey)?;
        let provider = AnthropicProvider::with_options(key, self.options.clone())?;
        Ok(Switched::new(provider, Arc::clone(&self.switch)))
    }

    /// The model list: live from the provider while AI is active and a key is stored, otherwise
    /// (or when that fails) the built-in list. Never fails.
    pub async fn models(self: &Arc<Self>) -> AiModels {
        let fallback = |error: Option<String>| AiModels {
            models: quarry_ai_anthropic::fallback_models(),
            live: false,
            error,
        };
        if !self.switch.allowed() {
            return fallback(None);
        }
        let this = Arc::clone(self);
        let provider = match tauri::async_runtime::spawn_blocking(move || this.provider()).await {
            Ok(Ok(p)) => p,
            Ok(Err(e)) if e.kind == "ai_no_key" || e.kind == "ai_disabled" => {
                return fallback(None);
            }
            Ok(Err(e)) => return fallback(Some(e.message)),
            Err(e) => return fallback(Some(e.to_string())),
        };
        match provider.models().await {
            Ok(models) if !models.is_empty() => AiModels {
                models,
                live: true,
                error: None,
            },
            Ok(_) => fallback(None),
            Err(e) => {
                tracing::warn!(kind = e.kind(), "could not list AI models");
                fallback(Some(e.to_string()))
            }
        }
    }

    /// Starts a streamed completion; events go to `sink` until `Done` or `Failed`. Fails at once
    /// when AI is off or no key is stored. Returns the request id for [`Ai::cancel`].
    pub async fn start<F>(
        self: &Arc<Self>,
        request: CompletionRequest,
        sink: F,
    ) -> Result<String, AppError>
    where
        F: Fn(AiStreamEvent) + Send + 'static,
    {
        let this = Arc::clone(self);
        let provider = tauri::async_runtime::spawn_blocking(move || this.provider())
            .await
            .map_err(|e| AppError::new("internal", format!("AI task failed: {e}")))??;
        let id = uuid::Uuid::new_v4().to_string();
        let model = request.model.clone();
        let this = Arc::clone(self);
        let task_id = id.clone();
        // Spawned with the lock held, so the task cannot finish (and remove itself) before its
        // abort handle is registered.
        let mut running = lock(&self.running);
        let task = tauri::async_runtime::spawn(async move {
            let started = Instant::now();
            let failed = |e: AiError| {
                tracing::warn!(request = %task_id, kind = e.kind(), "AI request failed");
                AiStreamEvent::Failed { error: e.into() }
            };
            match provider.complete(request).await {
                Ok(mut events) => {
                    while let Some(event) = events.next().await {
                        match event {
                            Ok(event) => {
                                if let AiEvent::Done { usage, stop_reason } = &event {
                                    tracing::info!(
                                        request = %task_id,
                                        model = %model,
                                        input_tokens = usage.input_tokens,
                                        output_tokens = usage.output_tokens,
                                        stop = ?stop_reason,
                                        ms = started.elapsed().as_millis() as u64,
                                        "AI request finished"
                                    );
                                }
                                sink(event.into());
                            }
                            Err(e) => {
                                sink(failed(e));
                                break;
                            }
                        }
                    }
                }
                Err(e) => sink(failed(e)),
            }
            lock(&this.running).remove(&task_id);
        });
        running.insert(id.clone(), task.inner().abort_handle());
        Ok(id)
    }

    /// Stops a request: its task is aborted, which drops the stream and closes the connection.
    pub fn cancel(&self, request_id: &str) -> bool {
        match lock(&self.running).remove(request_id) {
            Some(handle) => {
                handle.abort();
                tracing::info!(request = %request_id, "AI request cancelled");
                true
            }
            None => false,
        }
    }

    fn cancel_all(&self) {
        for (_, handle) in lock(&self.running).drain() {
            handle.abort();
        }
    }

    #[cfg(test)]
    fn running(&self) -> usize {
        lock(&self.running).len()
    }
}

/// The request behind Settings > AI > Test: tiny, and free of any user data.
pub fn test_request(model: String) -> CompletionRequest {
    CompletionRequest {
        model,
        system: Some("This is a connection test from Quarry, a database tool.".into()),
        messages: vec![Message::user("Reply with the single word OK.")],
        max_tokens: 1024,
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
        .map_err(|e| AppError::new("internal", format!("AI settings task failed: {e}")))?
}

#[tauri::command]
pub async fn ai_settings_get(ai: AiState<'_>) -> Result<AiStatus, AppError> {
    blocking(&ai, |a| a.status()).await
}

#[tauri::command]
pub async fn ai_settings_set(ai: AiState<'_>, settings: AiSettings) -> Result<AiStatus, AppError> {
    blocking(&ai, move |a| a.set_settings(&settings)).await
}

#[tauri::command]
pub async fn ai_key_set(ai: AiState<'_>, key: SecretString) -> Result<AiStatus, AppError> {
    blocking(&ai, move |a| a.set_key(&key)).await
}

#[tauri::command]
pub async fn ai_key_clear(ai: AiState<'_>) -> Result<AiStatus, AppError> {
    blocking(&ai, |a| a.clear_key()).await
}

#[tauri::command]
pub async fn ai_models(ai: AiState<'_>) -> Result<AiModels, AppError> {
    Ok(ai.models().await)
}

/// Streams a short test answer with the chosen model; the id cancels it.
#[tauri::command]
pub async fn ai_test(
    ai: AiState<'_>,
    on_event: Channel<AiStreamEvent>,
) -> Result<String, AppError> {
    let model = blocking(&ai, |a| Ok(a.store.ai_settings()?.model)).await?;
    ai.start(test_request(model), move |event| {
        let _ = on_event.send(event);
    })
    .await
}

#[tauri::command]
pub fn ai_cancel(ai: AiState<'_>, request_id: String) {
    ai.cancel(&request_id);
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use quarry_secrets::MemoryStore;
    use quarry_store::{AiIgnoreKind, AiIgnoreRule};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;

    use super::*;

    const KEY: &str = "sk-ant-api03-LEAK-CANARY-ai-7f3c";

    /// A stand-in API that counts connections and streams `OK` slowly until the client leaves.
    async fn api() -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://{}", listener.local_addr().expect("addr"));
        let count = Arc::new(AtomicUsize::new(0));
        let seen = Arc::clone(&count);
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                seen.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 65536];
                    let _ = socket.read(&mut buf).await;
                    let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
                    let start = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"model\":\"claude-sonnet-5-5\",\"usage\":{\"input_tokens\":5}}}\n\n";
                    let _ = socket.write_all(format!("{head}{start}").as_bytes()).await;
                    for _ in 0..200 {
                        let delta = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\n";
                        if socket.write_all(delta.as_bytes()).await.is_err() {
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                    let stop = "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
                    let _ = socket.write_all(stop.as_bytes()).await;
                });
            }
        });
        (url, count)
    }

    fn ai_with(store: Arc<Store>, url: &str) -> Arc<Ai> {
        let keyring: Arc<dyn CredentialStore> = Arc::new(MemoryStore::default());
        Arc::new(
            Ai::new(
                store,
                keyring,
                Options {
                    base_url: url.into(),
                    ..Options::default()
                },
            )
            .expect("ai"),
        )
    }

    fn enabled() -> AiSettings {
        AiSettings {
            enabled: true,
            ..AiSettings::default()
        }
    }

    #[test]
    fn default_model_is_the_providers() {
        assert_eq!(
            quarry_store::DEFAULT_AI_MODEL,
            quarry_ai_anthropic::DEFAULT_MODEL
        );
    }

    #[test]
    fn the_key_stays_out_of_app_db_and_ipc_responses() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Arc::new(Store::open(&dir.path().join("app.db")).expect("store"));
        let ai = ai_with(Arc::clone(&store), "http://127.0.0.1:9");
        let status = ai.set_key(&SecretString::new(KEY.into())).expect("set key");
        assert!(status.key_stored);
        let status = ai
            .set_settings(&AiSettings {
                ignore: vec![AiIgnoreRule {
                    kind: AiIgnoreKind::Column,
                    pattern: "*password*".into(),
                }],
                ..enabled()
            })
            .expect("settings");
        let responses = [
            serde_json::to_string(&status).expect("encode"),
            serde_json::to_string(&ai.status().expect("status")).expect("encode"),
        ];
        for json in &responses {
            assert!(!json.contains(KEY), "the key crossed IPC: {json}");
            assert!(!json.contains("LEAK-CANARY"));
        }
        assert_eq!(
            ai.keyring
                .get(KEY_ACCOUNT)
                .expect("get")
                .map(|k| k.expose().to_owned()),
            Some(KEY.to_owned()),
            "the key lives in the credential store"
        );
        drop(ai);
        drop(store);
        for entry in std::fs::read_dir(dir.path()).expect("dir") {
            let path = entry.expect("entry").path();
            let bytes = std::fs::read(&path).expect("read");
            assert!(
                !String::from_utf8_lossy(&bytes).contains("LEAK-CANARY"),
                "the key reached {}",
                path.display()
            );
        }
    }

    #[test]
    fn rejects_malformed_keys() {
        let ai = ai_with(
            Arc::new(Store::open_in_memory().expect("store")),
            "http://x",
        );
        for bad in ["", "sk-ant a", "sk\n", &"k".repeat(MAX_KEY_LEN + 1)] {
            let err = ai.set_key(&SecretString::new(bad.into())).expect_err(bad);
            assert_eq!(err.kind, "invalid");
            assert!(!err.message.contains(bad) || bad.is_empty());
        }
        assert!(!ai.status().expect("status").key_stored);
        let status = ai.set_key(&SecretString::new(KEY.into())).expect("ok");
        assert!(status.key_stored);
        assert!(!ai.clear_key().expect("clear").key_stored);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn with_ai_off_nothing_is_sent() {
        let (url, connections) = api().await;
        let ai = ai_with(Arc::new(Store::open_in_memory().expect("store")), &url);
        ai.set_key(&SecretString::new(KEY.into())).expect("key");
        // Off globally (the default).
        let err = ai
            .start(test_request("m".into()), |_| {})
            .await
            .expect_err("off");
        assert_eq!(err.kind, "ai_disabled");
        let models = ai.models().await;
        assert!(!models.live);
        assert!(models.error.is_none());
        // On, but off for this workspace.
        ai.set_settings(&AiSettings {
            disabled_workspaces: vec![WORKSPACE_ID.into()],
            ..enabled()
        })
        .expect("settings");
        assert!(!ai.status().expect("status").active);
        let err = ai
            .start(test_request("m".into()), |_| {})
            .await
            .expect_err("off here");
        assert_eq!(err.kind, "ai_disabled");
        assert!(!ai.models().await.live);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(connections.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn no_key_is_a_clear_error() {
        let ai = ai_with(
            Arc::new(Store::open_in_memory().expect("store")),
            "http://127.0.0.1:9",
        );
        ai.set_settings(&enabled()).expect("settings");
        let err = ai
            .start(test_request("m".into()), |_| {})
            .await
            .expect_err("no key");
        assert_eq!(err.kind, "ai_no_key");
        // The list falls back quietly.
        let models = ai.models().await;
        assert!(!models.live && models.error.is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn streams_and_cancels_and_switching_off_stops_requests() {
        let (url, connections) = api().await;
        let ai = ai_with(Arc::new(Store::open_in_memory().expect("store")), &url);
        ai.set_key(&SecretString::new(KEY.into())).expect("key");
        ai.set_settings(&enabled()).expect("settings");

        let (tx, mut rx) = mpsc::unbounded_channel();
        let id = ai
            .start(test_request("claude-sonnet-5-5".into()), move |e| {
                let _ = tx.send(e);
            })
            .await
            .expect("started");
        assert!(matches!(
            rx.recv().await,
            Some(AiStreamEvent::Started { .. })
        ));
        assert!(matches!(rx.recv().await, Some(AiStreamEvent::Text { .. })));
        assert!(matches!(rx.recv().await, Some(AiStreamEvent::Text { .. })));
        assert_eq!(ai.running(), 1);
        assert!(ai.cancel(&id));
        assert_eq!(ai.running(), 0);
        // The task is gone: the sink is dropped and no more events arrive.
        let rest = tokio::time::timeout(Duration::from_secs(2), async {
            let mut n = 0;
            while rx.recv().await.is_some() {
                n += 1;
            }
            n
        })
        .await
        .expect("channel closes");
        assert!(
            rest <= 1,
            "at most one in-flight event after cancel, got {rest}"
        );
        assert!(!ai.cancel(&id), "already cancelled");

        // Turning AI off stops what is running.
        let (tx, mut rx) = mpsc::unbounded_channel();
        ai.start(test_request("claude-sonnet-5-5".into()), move |e| {
            let _ = tx.send(e);
        })
        .await
        .expect("started");
        assert!(matches!(
            rx.recv().await,
            Some(AiStreamEvent::Started { .. })
        ));
        ai.set_settings(&AiSettings::default()).expect("off");
        assert_eq!(ai.running(), 0);
        assert_eq!(connections.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn stream_events_serialize_for_the_ui() {
        let json = serde_json::to_value(AiStreamEvent::Failed {
            error: AiError::Overloaded.into(),
        })
        .expect("encode");
        assert_eq!(json["type"], "failed");
        assert_eq!(json["error"]["kind"], "ai_overloaded");
        let json = serde_json::to_value(AiStreamEvent::from(AiEvent::Done {
            stop_reason: Some(StopReason::MaxTokens),
            usage: Usage::default(),
        }))
        .expect("encode");
        assert_eq!(json["stopReason"], "max_tokens");
    }
}
