//! The API key never reaches the log file, even at trace level with the HTTP stack logging. A
//! separate test binary with a single test, so the global subscriber sees every event.

mod common;

use common::{KEY, Reply, START, delta, end, provider, request, server, sse};
use futures_util::StreamExt;
use quarry_ai_core::AiProvider;
use quarry_logging::{LOG_FILE, RedactingWriter, RotatingFile, subscriber};

#[tokio::test]
async fn the_key_never_reaches_the_log_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = RotatingFile::open(dir.path(), LOG_FILE, 1 << 22, 1).expect("log file");
    tracing::subscriber::set_global_default(subscriber(
        RedactingWriter::new(file, false),
        "trace".parse().expect("filter"),
    ))
    .expect("global subscriber");

    let s = server().await;
    s.replies
        .send(Reply::Stream(
            vec![(None, sse("message_start", START) + &delta("OK") + &end())],
            None,
        ))
        .ok();
    s.replies
        .send(Reply::Json(
            401,
            "Unauthorized",
            vec![],
            format!(
                r#"{{"type":"error","error":{{"type":"authentication_error","message":"bad key {KEY}"}}}}"#
            ),
        ))
        .ok();
    s.replies
        .send(Reply::Json(
            200,
            "OK",
            vec![],
            r#"{"data":[],"has_more":false}"#.into(),
        ))
        .ok();
    let p = provider(&s.url);
    let events: Vec<_> = p
        .complete(request())
        .await
        .expect("accepted")
        .collect()
        .await;
    assert!(events.iter().all(Result::is_ok));
    let err = p.complete(request()).await.err().expect("401");
    tracing::warn!(error = %err, debug = ?err, "AI request failed");
    p.models().await.expect("models");
    drop(p);

    let mut logged = String::new();
    for entry in std::fs::read_dir(dir.path()).expect("log dir") {
        let path = entry.expect("entry").path();
        logged.push_str(&String::from_utf8_lossy(
            &std::fs::read(&path).expect("read"),
        ));
    }
    assert!(!logged.is_empty(), "trace logging produced output");
    assert!(!logged.contains(KEY), "the API key reached the log");
    assert!(
        !logged.contains("Canary-Key"),
        "part of the API key reached the log"
    );
}
