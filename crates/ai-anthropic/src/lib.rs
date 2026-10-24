//! Anthropic Messages API provider. Requests go from Rust straight to the API over HTTPS (rustls
//! with the ring provider and the system's trusted roots); the WebView never touches the network.
//! The key is sent only in the `x-api-key` header and never appears in errors or logs.

mod events;
mod sse;

use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::{StreamExt, stream};
use quarry_ai_core::{
    AiError, AiProvider, Capabilities, CompletionRequest, EventStream, ModelInfo,
};
use quarry_secrets::SecretString;
use serde::Deserialize;
use serde_json::json;

pub use events::{Decoder, map_error};
pub use sse::{SseEvent, SseParser};

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
/// The API version this client speaks (no sampling parameters are sent, as it requires).
pub const API_VERSION: &str = "2026-10-21";
/// The model a new profile uses: the current Claude Sonnet.
pub const DEFAULT_MODEL: &str = "claude-sonnet-5-5";

/// Offered when the models endpoint cannot be reached. Update with model releases.
pub const FALLBACK_MODELS: &[(&str, &str)] = &[
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
    ("claude-fable-5-1", "Claude Fable 5.1"),
];

/// Models whose declined requests the API can retry on another model by itself
/// (`fallbacks: "default"`). Haiku has no server-side fallback.
const FALLBACK_CAPABLE: &[&str] = &[
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
];
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

pub fn fallback_models() -> Vec<ModelInfo> {
    FALLBACK_MODELS
        .iter()
        .map(|(id, name)| ModelInfo {
            id: (*id).into(),
            display_name: (*name).into(),
        })
        .collect()
}

#[derive(Debug, Clone)]
pub struct Options {
    pub base_url: String,
    pub connect_timeout: Duration,
    /// Longest silence allowed while a response streams (the API sends pings meanwhile).
    pub idle_timeout: Duration,
    /// Whole-request limit for short calls (models list); streams have no total limit.
    pub request_timeout: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.into(),
            connect_timeout: Duration::from_secs(15),
            idle_timeout: Duration::from_secs(90),
            request_timeout: Duration::from_secs(30),
        }
    }
}

pub struct AnthropicProvider {
    http: reqwest::Client,
    key: Arc<SecretString>,
    options: Options,
}

fn tls_config() -> rustls::ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring supports the default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    config
}

impl AnthropicProvider {
    pub fn new(key: SecretString) -> Result<Self, AiError> {
        Self::with_options(key, Options::default())
    }

    pub fn with_options(key: SecretString, options: Options) -> Result<Self, AiError> {
        if key.expose().trim().is_empty() {
            return Err(AiError::NoKey);
        }
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(tls_config())
            .connect_timeout(options.connect_timeout)
            .read_timeout(options.idle_timeout)
            .user_agent(concat!("Quarry/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|e| AiError::Network(format!("could not set up HTTPS: {e}")))?;
        Ok(Self {
            http,
            key: Arc::new(key),
            options,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.options.base_url.trim_end_matches('/'))
    }

    fn headers(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request
            .header("x-api-key", self.key.expose())
            .header("anthropic-version", API_VERSION)
    }

    /// Removes the key from text that came back from the network, in case a server echoes it.
    fn scrub(&self, text: String) -> String {
        let key = self.key.expose();
        if text.contains(key) {
            text.replace(key, "***")
        } else {
            text
        }
    }

    fn network_error(&self, e: &reqwest::Error) -> AiError {
        if e.is_timeout() {
            return AiError::Timeout;
        }
        // reqwest's Display omits the cause; walk the chain for the useful part.
        let mut message = e.to_string();
        let mut source = std::error::Error::source(e);
        while let Some(cause) = source {
            message = format!("{message}: {cause}");
            source = cause.source();
        }
        AiError::Network(self.scrub(message))
    }

    async fn error_from(&self, response: reqwest::Response) -> AiError {
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok());
        let body = response.text().await.unwrap_or_default();
        let (kind, message) = match serde_json::from_str::<events::ErrorBody>(&body) {
            Ok(b) => (b.error.kind, b.error.message),
            Err(_) => (String::new(), String::new()),
        };
        map_error(Some(status), &kind, self.scrub(message), retry_after)
    }

    fn body(request: &CompletionRequest) -> serde_json::Value {
        let mut body = json!({
            "model": request.model,
            "max_tokens": request.max_tokens,
            "stream": true,
            "messages": request.messages,
        });
        if let Some(system) = &request.system {
            body["system"] = json!(system);
        }
        if FALLBACK_CAPABLE.contains(&request.model.as_str()) {
            body["fallbacks"] = json!("default");
        }
        body
    }
}

#[derive(Deserialize)]
struct ModelsPage {
    data: Vec<WireModel>,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    last_id: Option<String>,
}

#[derive(Deserialize)]
struct WireModel {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
}

/// More pages than this means something is wrong; stop rather than loop.
const MAX_MODEL_PAGES: usize = 10;

impl AiProvider for AnthropicProvider {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            streaming: true,
            tools: false,
            list_models: true,
        }
    }

    fn complete(&self, request: CompletionRequest) -> BoxFuture<'_, Result<EventStream, AiError>> {
        Box::pin(async move {
            let mut builder = self
                .headers(self.http.post(self.url("/v1/messages")))
                .json(&Self::body(&request));
            if FALLBACK_CAPABLE.contains(&request.model.as_str()) {
                builder = builder.header("anthropic-beta", FALLBACK_BETA);
            }
            let response = builder.send().await.map_err(|e| self.network_error(&e))?;
            if !response.status().is_success() {
                return Err(self.error_from(response).await);
            }
            let key = Arc::clone(&self.key);
            let state = (
                response.bytes_stream().boxed(),
                SseParser::default(),
                Decoder::default(),
                std::collections::VecDeque::new(),
                false,
            );
            let events = stream::unfold(
                state,
                move |(mut body, mut parser, mut decoder, mut queue, mut ended)| {
                    let key = Arc::clone(&key);
                    async move {
                        loop {
                            if let Some(item) = queue.pop_front() {
                                return Some((item, (body, parser, decoder, queue, ended)));
                            }
                            if ended {
                                return None;
                            }
                            match body.next().await {
                                Some(Ok(chunk)) => match parser.push(&chunk) {
                                    Ok(sse) => {
                                        for event in sse {
                                            match decoder.decode(&event) {
                                                Ok(Some(e)) => queue.push_back(Ok(e)),
                                                Ok(None) => {}
                                                Err(e) => {
                                                    queue.push_back(Err(e));
                                                    ended = true;
                                                    break;
                                                }
                                            }
                                            if decoder.finished() {
                                                ended = true;
                                                break;
                                            }
                                        }
                                    }
                                    Err(_) => {
                                        queue.push_back(Err(AiError::Protocol(
                                            "a stream line was too long".into(),
                                        )));
                                        ended = true;
                                    }
                                },
                                Some(Err(e)) => {
                                    let error = if e.is_timeout() {
                                        AiError::Timeout
                                    } else {
                                        let text = e.to_string();
                                        AiError::Network(text.replace(key.expose(), "***"))
                                    };
                                    queue.push_back(Err(error));
                                    ended = true;
                                }
                                None => {
                                    queue.push_back(Err(AiError::Protocol(
                                        "the response ended before it was complete".into(),
                                    )));
                                    ended = true;
                                }
                            }
                        }
                    }
                },
            );
            Ok(events.boxed())
        })
    }

    fn models(&self) -> BoxFuture<'_, Result<Vec<ModelInfo>, AiError>> {
        Box::pin(async move {
            let mut models = Vec::new();
            let mut after: Option<String> = None;
            for _ in 0..MAX_MODEL_PAGES {
                let mut query = vec![("limit", "100".to_owned())];
                if let Some(id) = &after {
                    query.push(("after_id", id.clone()));
                }
                let response = self
                    .headers(self.http.get(self.url("/v1/models")))
                    .query(&query)
                    .timeout(self.options.request_timeout)
                    .send()
                    .await
                    .map_err(|e| self.network_error(&e))?;
                if !response.status().is_success() {
                    return Err(self.error_from(response).await);
                }
                let page: ModelsPage = response.json().await.map_err(|e| {
                    AiError::Protocol(format!("could not read the models list: {e}"))
                })?;
                models.extend(page.data.into_iter().map(|m| ModelInfo {
                    display_name: m.display_name.unwrap_or_else(|| m.id.clone()),
                    id: m.id,
                }));
                match (page.has_more, page.last_id) {
                    (true, Some(last)) => after = Some(last),
                    _ => break,
                }
            }
            Ok(models)
        })
    }
}

#[cfg(test)]
mod tests {
    use quarry_ai_core::Message;

    use super::*;

    #[test]
    fn request_body_streams_and_never_sends_sampling_parameters() {
        let request = CompletionRequest {
            model: DEFAULT_MODEL.into(),
            system: Some("You write PostgreSQL.".into()),
            messages: vec![Message::user("count orders")],
            max_tokens: 1024,
        };
        let body = AnthropicProvider::body(&request);
        assert_eq!(body["stream"], true);
        assert_eq!(body["model"], "claude-sonnet-5-5");
        assert_eq!(body["system"], "You write PostgreSQL.");
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "count orders");
        assert_eq!(body["fallbacks"], "default");
        for absent in ["temperature", "top_p", "top_k", "tools"] {
            assert!(body.get(absent).is_none(), "{absent} must not be sent");
        }
        let haiku = CompletionRequest {
            model: "claude-haiku-5-5".into(),
            system: None,
            ..request
        };
        let body = AnthropicProvider::body(&haiku);
        assert!(body.get("fallbacks").is_none());
        assert!(body.get("system").is_none());
    }

    #[test]
    fn empty_key_is_no_key() {
        assert_eq!(
            AnthropicProvider::new(SecretString::new("  ".into())).err(),
            Some(AiError::NoKey)
        );
    }

    #[test]
    fn default_model_is_offered_offline() {
        assert!(fallback_models().iter().any(|m| m.id == DEFAULT_MODEL));
    }
}
