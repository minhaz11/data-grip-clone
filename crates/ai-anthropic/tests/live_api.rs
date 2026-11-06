//! A real streaming call. Ignored by default; it costs a few tokens. Run with:
//! `QUARRY_ANTHROPIC_TEST_KEY=sk-ant-... cargo test -p quarry-ai-anthropic -- --ignored live`

use futures_util::StreamExt;
use quarry_ai_anthropic::{AnthropicProvider, DEFAULT_MODEL};
use quarry_ai_core::{AiEvent, AiProvider, CompletionRequest, Message};
use quarry_secrets::SecretString;

#[tokio::test]
#[ignore = "calls the real API; needs QUARRY_ANTHROPIC_TEST_KEY"]
async fn live_streaming_call() {
    let Ok(key) = std::env::var("QUARRY_ANTHROPIC_TEST_KEY") else {
        eprintln!("QUARRY_ANTHROPIC_TEST_KEY is not set; skipping");
        return;
    };
    let provider = AnthropicProvider::new(SecretString::new(key)).expect("provider");
    let models = provider.models().await.expect("models");
    assert!(!models.is_empty());
    let mut events = provider
        .complete(CompletionRequest {
            model: DEFAULT_MODEL.into(),
            system: None,
            messages: vec![Message::user("Reply with the single word OK.")],
            max_tokens: 2000,
        })
        .await
        .expect("accepted");
    let mut text = String::new();
    let mut done = false;
    while let Some(event) = events.next().await {
        match event.expect("event") {
            AiEvent::Text { text: t } => text.push_str(&t),
            AiEvent::Done { .. } => done = true,
            AiEvent::Started { .. } => {}
        }
    }
    assert!(done, "stream finished");
    assert!(text.to_uppercase().contains("OK"), "{text}");
}
