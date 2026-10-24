//! The provider against a local stand-in for the API: streaming, cancel, errors, timeouts, the
//! kill switch and the key's whereabouts.

mod common;

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use common::{KEY, Reply, START, delta, end, provider, request, server, sse};
use futures_util::StreamExt;
use quarry_ai_core::{AiError, AiEvent, AiProvider, KillSwitch, StopReason, Switched};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

#[tokio::test]
async fn streams_incrementally_with_the_right_headers() {
    let mut s = server().await;
    let (more_tx, more_rx) = oneshot::channel();
    s.replies
        .send(Reply::Stream(
            vec![
                (None, sse("message_start", START) + &delta("O")),
                (Some(more_rx), delta("K") + &end()),
            ],
            None,
        ))
        .ok();
    let p = provider(&s.url);
    let mut events = p.complete(request()).await.expect("accepted");
    assert_eq!(
        events.next().await,
        Some(Ok(AiEvent::Started {
            model: "claude-sonnet-5-5".into()
        }))
    );
    // The first piece arrives while the server is still holding back the rest.
    assert_eq!(
        events.next().await,
        Some(Ok(AiEvent::Text { text: "O".into() }))
    );
    more_tx.send(()).expect("open gate");
    assert_eq!(
        events.next().await,
        Some(Ok(AiEvent::Text { text: "K".into() }))
    );
    match events.next().await {
        Some(Ok(AiEvent::Done { stop_reason, usage })) => {
            assert_eq!(stop_reason, Some(StopReason::EndTurn));
            assert_eq!((usage.input_tokens, usage.output_tokens), (10, 4));
        }
        other => panic!("expected Done, got {other:?}"),
    }
    assert_eq!(events.next().await, None);

    let got = s.received.recv().await.expect("request");
    let head = got.head.to_ascii_lowercase();
    assert!(
        got.head.starts_with("POST /v1/messages HTTP/1.1"),
        "{}",
        got.head
    );
    assert!(head.contains(&format!("x-api-key: {}", KEY.to_ascii_lowercase())));
    assert!(head.contains("anthropic-version: 2026-10-21"));
    assert!(head.contains("anthropic-beta: server-side-fallback-2026-07-01"));
    let body: serde_json::Value = serde_json::from_str(&got.body).expect("json body");
    assert_eq!(body["stream"], true);
    assert_eq!(body["messages"][0]["content"], "Say OK");
    assert!(
        !got.body.contains(KEY),
        "the key belongs in the header only"
    );
}

#[tokio::test]
async fn dropping_the_stream_cancels_the_request() {
    let s = server().await;
    let (_never_tx, never_rx) = oneshot::channel::<()>();
    let (closed_tx, closed_rx) = oneshot::channel();
    s.replies
        .send(Reply::Stream(
            vec![
                (None, sse("message_start", START) + &delta("partial")),
                (Some(never_rx), delta("never sent")),
            ],
            Some(closed_tx),
        ))
        .ok();
    let p = provider(&s.url);
    let mut events = p.complete(request()).await.expect("accepted");
    assert!(matches!(
        events.next().await,
        Some(Ok(AiEvent::Started { .. }))
    ));
    assert!(matches!(
        events.next().await,
        Some(Ok(AiEvent::Text { .. }))
    ));
    drop(events);
    tokio::time::timeout(Duration::from_secs(3), closed_rx)
        .await
        .expect("the server saw the connection close")
        .expect("signal");
}

#[tokio::test]
async fn http_errors_map_to_typed_errors_without_the_key() {
    let s = server().await;
    let error = |kind: &str, message: &str| {
        format!(
            r#"{{"type":"error","error":{{"type":"{kind}","message":"{message}"}},"request_id":"req_1"}}"#
        )
    };
    s.replies
        .send(Reply::Json(
            401,
            "Unauthorized",
            vec![],
            error("authentication_error", &format!("invalid x-api-key {KEY}")),
        ))
        .ok();
    s.replies
        .send(Reply::Json(
            429,
            "Too Many Requests",
            vec![("retry-after", "5")],
            error("rate_limit_error", "slow down"),
        ))
        .ok();
    s.replies
        .send(Reply::Json(
            529,
            "Overloaded",
            vec![],
            error("overloaded_error", "Overloaded"),
        ))
        .ok();
    s.replies
        .send(Reply::Json(
            500,
            "Internal Server Error",
            vec![],
            "not json".into(),
        ))
        .ok();
    let p = provider(&s.url);
    let auth = p.complete(request()).await.err().expect("401");
    assert_eq!(auth, AiError::Auth("invalid x-api-key ***".into()));
    assert!(!auth.to_string().contains(KEY));
    assert_eq!(
        p.complete(request()).await.err(),
        Some(AiError::RateLimited {
            retry_after_secs: Some(5)
        })
    );
    assert_eq!(p.complete(request()).await.err(), Some(AiError::Overloaded));
    assert_eq!(
        p.complete(request()).await.err(),
        Some(AiError::Server("HTTP 500".into()))
    );
}

#[tokio::test]
async fn error_event_mid_stream_ends_it() {
    let s = server().await;
    s.replies
        .send(Reply::Stream(
            vec![(
                None,
                sse("message_start", START)
                    + &delta("SEL")
                    + &sse(
                        "error",
                        r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
                    ),
            )],
            None,
        ))
        .ok();
    let events: Vec<_> = provider(&s.url)
        .complete(request())
        .await
        .expect("accepted")
        .collect()
        .await;
    assert_eq!(events.last(), Some(&Err(AiError::Overloaded)));
    assert_eq!(events.len(), 3);
}

#[tokio::test]
async fn a_cut_off_stream_is_an_error_not_a_short_answer() {
    let s = server().await;
    s.replies
        .send(Reply::Stream(
            vec![(None, sse("message_start", START) + &delta("SEL"))],
            None,
        ))
        .ok();
    let events: Vec<_> = provider(&s.url)
        .complete(request())
        .await
        .expect("accepted")
        .collect()
        .await;
    assert!(
        matches!(events.last(), Some(Err(AiError::Protocol(_)))),
        "{events:?}"
    );
}

#[tokio::test]
async fn a_silent_stream_times_out() {
    let s = server().await;
    s.replies.send(Reply::Stall).ok();
    let p = provider(&s.url);
    let mut events = p.complete(request()).await.expect("headers arrive");
    let next = tokio::time::timeout(Duration::from_secs(3), events.next())
        .await
        .expect("the idle timeout fires first");
    assert_eq!(next, Some(Err(AiError::Timeout)));
}

#[tokio::test]
async fn models_are_listed_across_pages() {
    let mut s = server().await;
    s.replies
        .send(Reply::Json(
            200,
            "OK",
            vec![],
            r#"{"data":[{"type":"model","id":"claude-sonnet-5-5","display_name":"Claude Sonnet 5.5"}],"has_more":true,"first_id":"claude-sonnet-5-5","last_id":"claude-sonnet-5-5"}"#.into(),
        ))
        .ok();
    s.replies
        .send(Reply::Json(
            200,
            "OK",
            vec![],
            r#"{"data":[{"type":"model","id":"claude-haiku-5-5","display_name":"Claude Haiku 5.5"}],"has_more":false,"first_id":"claude-haiku-5-5","last_id":"claude-haiku-5-5"}"#.into(),
        ))
        .ok();
    let models = provider(&s.url).models().await.expect("models");
    let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["claude-sonnet-5-5", "claude-haiku-5-5"]);
    let first = s.received.recv().await.expect("page 1");
    assert!(
        first.head.starts_with("GET /v1/models?limit=100 "),
        "{}",
        first.head
    );
    let second = s.received.recv().await.expect("page 2");
    assert!(
        second.head.contains("after_id=claude-sonnet-5-5"),
        "{}",
        second.head
    );
}

#[tokio::test]
async fn with_ai_off_no_request_leaves_the_app() {
    let s = server().await;
    let switch = Arc::new(KillSwitch::default());
    let p = Switched::new(provider(&s.url), Arc::clone(&switch));
    assert_eq!(p.complete(request()).await.err(), Some(AiError::Disabled));
    assert_eq!(p.models().await.err(), Some(AiError::Disabled));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        s.connections.load(Ordering::SeqCst),
        0,
        "nothing reached the network"
    );

    switch.set_allowed(true);
    s.replies
        .send(Reply::Json(
            200,
            "OK",
            vec![],
            r#"{"data":[],"has_more":false}"#.into(),
        ))
        .ok();
    p.models().await.expect("allowed now");
    assert_eq!(s.connections.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn unreachable_api_is_a_network_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = format!("http://{}", listener.local_addr().expect("addr"));
    drop(listener);
    let err = provider(&url)
        .complete(request())
        .await
        .err()
        .expect("refused");
    assert_eq!(err.kind(), "ai_network");
    assert!(!err.to_string().contains(KEY));
}
