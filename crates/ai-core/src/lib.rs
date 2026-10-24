//! AI provider contract (ADR-0005). A provider streams a completion as events, lists its models and
//! states what it can do. Nothing here knows about connections or schemas: what a request contains
//! is decided by the context builder (step 17), and whether a request may leave the machine at all
//! is decided by the [`KillSwitch`] that [`Switched`] checks before every call.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use serde::{Deserialize, Serialize};

/// Who wrote a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

impl Message {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
        }
    }
}

/// One completion: a system prompt, the conversation so far, and limits. No tools in the MVP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompletionRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub max_tokens: u32,
}

/// Token counts for one completion, as the provider reports them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
}

/// Why the model stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    MaxTokens,
    StopSequence,
    /// The provider's safety checks declined the request; the text so far may be partial.
    Refusal,
    /// Anything this build does not know yet.
    Other,
}

/// What a completion stream yields, in order: `Started`, any number of `Text`, then `Done`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AiEvent {
    /// The provider accepted the request; `model` is the one that answers.
    Started { model: String },
    /// The next piece of the answer.
    Text { text: String },
    Done {
        stop_reason: Option<StopReason>,
        usage: Usage,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
}

/// What a provider supports, so the UI can offer only what works.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub streaming: bool,
    pub tools: bool,
    pub list_models: bool,
}

/// Every way a request can fail. Messages are user-facing and never contain the key.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AiError {
    #[error("AI features are turned off")]
    Disabled,
    #[error("no API key is stored; add one in Settings > AI")]
    NoKey,
    #[error("the API key was rejected: {0}")]
    Auth(String),
    #[error("this key may not do that: {0}")]
    Permission(String),
    #[error("rate limited by the provider; try again{}", retry_hint(*.retry_after_secs))]
    RateLimited { retry_after_secs: Option<u64> },
    #[error("the provider is overloaded; try again shortly")]
    Overloaded,
    #[error("the request was rejected: {0}")]
    InvalidRequest(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("the request timed out")]
    Timeout,
    #[error("network error: {0}")]
    Network(String),
    #[error("provider error: {0}")]
    Server(String),
    #[error("unexpected response from the provider: {0}")]
    Protocol(String),
}

fn retry_hint(secs: Option<u64>) -> String {
    match secs {
        Some(s) => format!(" in {s} s"),
        None => " later".into(),
    }
}

impl AiError {
    /// A short stable name for the UI and logs.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Disabled => "ai_disabled",
            Self::NoKey => "ai_no_key",
            Self::Auth(_) => "ai_auth",
            Self::Permission(_) => "ai_permission",
            Self::RateLimited { .. } => "ai_rate_limited",
            Self::Overloaded => "ai_overloaded",
            Self::InvalidRequest(_) => "ai_invalid_request",
            Self::NotFound(_) => "ai_not_found",
            Self::Timeout => "ai_timeout",
            Self::Network(_) => "ai_network",
            Self::Server(_) => "ai_server",
            Self::Protocol(_) => "ai_protocol",
        }
    }

    /// Whether trying the same request again later can succeed.
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::RateLimited { .. }
                | Self::Overloaded
                | Self::Timeout
                | Self::Network(_)
                | Self::Server(_)
        )
    }
}

pub type EventStream = BoxStream<'static, Result<AiEvent, AiError>>;

/// A request rendered to the exact bytes the provider will send, so what the user previewed is
/// what leaves the machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedRequest {
    pub model: String,
    pub body: String,
}

/// An AI backend. Dropping the stream returned by `send` cancels the request.
pub trait AiProvider: Send + Sync {
    fn capabilities(&self) -> Capabilities;
    /// Renders a request without sending it (no network, no key).
    fn prepare(&self, request: &CompletionRequest) -> PreparedRequest;
    /// Sends exactly `prepared.body`; the future resolves once the provider has accepted it.
    fn send(&self, prepared: PreparedRequest) -> BoxFuture<'_, Result<EventStream, AiError>>;
    fn complete(&self, request: CompletionRequest) -> BoxFuture<'_, Result<EventStream, AiError>> {
        let prepared = self.prepare(&request);
        self.send(prepared)
    }
    fn models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>, AiError>>;
}

/// The global "AI off" switch. Off by default: nothing leaves the machine until the user turns AI
/// on in Settings.
#[derive(Debug, Default)]
pub struct KillSwitch(AtomicBool);

impl KillSwitch {
    pub fn set_allowed(&self, allowed: bool) {
        self.0.store(allowed, Ordering::SeqCst);
    }

    pub fn allowed(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> Result<(), AiError> {
        if self.allowed() {
            Ok(())
        } else {
            Err(AiError::Disabled)
        }
    }
}

/// A provider behind the kill switch: while AI is off, every call fails with
/// [`AiError::Disabled`] before the inner provider is touched.
pub struct Switched<P> {
    inner: P,
    switch: Arc<KillSwitch>,
}

impl<P: AiProvider> Switched<P> {
    pub fn new(inner: P, switch: Arc<KillSwitch>) -> Self {
        Self { inner, switch }
    }
}

impl<P: AiProvider> AiProvider for Switched<P> {
    fn capabilities(&self) -> Capabilities {
        self.inner.capabilities()
    }

    fn prepare(&self, request: &CompletionRequest) -> PreparedRequest {
        self.inner.prepare(request)
    }

    fn send(&self, prepared: PreparedRequest) -> BoxFuture<'_, Result<EventStream, AiError>> {
        if let Err(e) = self.switch.check() {
            return Box::pin(std::future::ready(Err(e)));
        }
        self.inner.send(prepared)
    }

    fn models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>, AiError>> {
        if let Err(e) = self.switch.check() {
            return Box::pin(std::future::ready(Err(e)));
        }
        self.inner.models()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use futures_util::StreamExt;

    use super::*;

    #[derive(Default)]
    struct Counting {
        calls: AtomicUsize,
    }

    impl AiProvider for Counting {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                streaming: true,
                tools: false,
                list_models: true,
            }
        }

        fn prepare(&self, request: &CompletionRequest) -> PreparedRequest {
            PreparedRequest {
                model: request.model.clone(),
                body: request.messages[0].content.clone(),
            }
        }

        fn send(&self, _: PreparedRequest) -> BoxFuture<'_, Result<EventStream, AiError>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let events = vec![
                Ok(AiEvent::Started { model: "m".into() }),
                Ok(AiEvent::Text { text: "hi".into() }),
            ];
            Box::pin(async move { Ok(futures_util::stream::iter(events).boxed()) })
        }

        fn models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>, AiError>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(Vec::new()) })
        }
    }

    fn request() -> CompletionRequest {
        CompletionRequest {
            model: "m".into(),
            system: None,
            messages: vec![Message::user("hello")],
            max_tokens: 16,
        }
    }

    #[tokio::test]
    async fn kill_switch_blocks_requests_before_the_provider() {
        let switch = Arc::new(KillSwitch::default());
        let provider = Switched::new(Counting::default(), Arc::clone(&switch));
        assert!(!switch.allowed(), "AI starts switched off");
        assert_eq!(
            provider.complete(request()).await.err(),
            Some(AiError::Disabled)
        );
        assert_eq!(provider.models().await.err(), Some(AiError::Disabled));
        assert_eq!(provider.inner.calls.load(Ordering::SeqCst), 0);

        switch.set_allowed(true);
        let events: Vec<_> = provider
            .complete(request())
            .await
            .expect("allowed")
            .collect()
            .await;
        assert_eq!(events.len(), 2);
        assert_eq!(provider.inner.calls.load(Ordering::SeqCst), 1);

        switch.set_allowed(false);
        assert_eq!(
            provider.complete(request()).await.err(),
            Some(AiError::Disabled)
        );
        assert_eq!(provider.inner.calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn errors_have_kinds_and_retry_advice() {
        assert_eq!(AiError::Overloaded.kind(), "ai_overloaded");
        assert!(AiError::Overloaded.is_retryable());
        assert!(!AiError::Auth("bad".into()).is_retryable());
        assert_eq!(
            AiError::RateLimited {
                retry_after_secs: Some(7)
            }
            .to_string(),
            "rate limited by the provider; try again in 7 s"
        );
    }

    #[test]
    fn events_serialize_for_the_ui() {
        let json = serde_json::to_value(AiEvent::Done {
            stop_reason: Some(StopReason::EndTurn),
            usage: Usage {
                input_tokens: 3,
                ..Usage::default()
            },
        })
        .expect("encode");
        assert_eq!(json["type"], "done");
        assert_eq!(json["stopReason"], "end_turn");
        assert_eq!(json["usage"]["inputTokens"], 3);
    }
}
