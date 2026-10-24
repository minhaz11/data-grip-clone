//! A local stand-in for the Messages API: scripted replies, recorded requests, a connection count.

#![allow(dead_code)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use quarry_ai_anthropic::{AnthropicProvider, Options};
use quarry_ai_core::{CompletionRequest, Message};
use quarry_secrets::SecretString;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};

pub const KEY: &str = "sk-ant-test-Canary-Key-1234567890";

/// What the stand-in received.
#[derive(Debug)]
pub struct Received {
    pub head: String,
    pub body: String,
}

/// One scripted reply. `Stream` parts are written one by one, each after its gate opens.
pub enum Reply {
    Json(u16, &'static str, Vec<(&'static str, &'static str)>, String),
    Stream(
        Vec<(Option<oneshot::Receiver<()>>, String)>,
        Option<oneshot::Sender<()>>,
    ),
    /// Headers, then silence.
    Stall,
}

pub struct Server {
    pub url: String,
    pub connections: Arc<AtomicUsize>,
    pub received: mpsc::UnboundedReceiver<Received>,
    pub replies: mpsc::UnboundedSender<Reply>,
}

async fn read_request(socket: &mut TcpStream) -> Option<Received> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let length = head
        .lines()
        .find_map(|l| {
            let (name, value) = l.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    while buf.len() < head_end + length {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Some(Received {
        head,
        body: String::from_utf8_lossy(&buf[head_end..]).into_owned(),
    })
}

async fn serve(
    listener: TcpListener,
    connections: Arc<AtomicUsize>,
    received: mpsc::UnboundedSender<Received>,
    mut replies: mpsc::UnboundedReceiver<Reply>,
) {
    while let Ok((mut socket, _)) = listener.accept().await {
        connections.fetch_add(1, Ordering::SeqCst);
        let Some(request) = read_request(&mut socket).await else {
            continue;
        };
        let _ = received.send(request);
        let Some(reply) = replies.recv().await else {
            return;
        };
        match reply {
            Reply::Json(status, reason, headers, body) => {
                let mut head = format!(
                    "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n",
                    body.len()
                );
                for (name, value) in headers {
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                head.push_str("\r\n");
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(body.as_bytes()).await;
            }
            Reply::Stream(parts, closed) => {
                let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
                let _ = socket.write_all(head.as_bytes()).await;
                let mut gone = false;
                for (gate, text) in parts {
                    if let Some(gate) = gate {
                        // While held back, notice a client that hangs up.
                        let mut byte = [0u8; 1];
                        tokio::select! {
                            _ = gate => {}
                            _ = socket.read(&mut byte) => {
                                gone = true;
                                break;
                            }
                        }
                    }
                    if socket.write_all(text.as_bytes()).await.is_err()
                        || socket.flush().await.is_err()
                    {
                        gone = true;
                        break;
                    }
                }
                if let Some(closed) = closed {
                    // Wait until the client hangs up (a read of 0 bytes or an error).
                    if !gone {
                        let mut byte = [0u8; 1];
                        let _ =
                            tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte))
                                .await;
                    }
                    let _ = closed.send(());
                }
            }
            Reply::Stall => {
                let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n";
                let _ = socket.write_all(head.as_bytes()).await;
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

pub async fn server() -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let url = format!("http://{}", listener.local_addr().expect("addr"));
    let connections = Arc::new(AtomicUsize::new(0));
    let (received_tx, received) = mpsc::unbounded_channel();
    let (replies, replies_rx) = mpsc::unbounded_channel();
    tokio::spawn(serve(
        listener,
        Arc::clone(&connections),
        received_tx,
        replies_rx,
    ));
    Server {
        url,
        connections,
        received,
        replies,
    }
}

pub fn provider(url: &str) -> AnthropicProvider {
    AnthropicProvider::with_options(
        SecretString::new(KEY.into()),
        Options {
            base_url: url.into(),
            idle_timeout: Duration::from_millis(400),
            ..Options::default()
        },
    )
    .expect("provider")
}

pub fn request() -> CompletionRequest {
    CompletionRequest {
        model: "claude-sonnet-5-5".into(),
        system: Some("Answer briefly.".into()),
        messages: vec![Message::user("Say OK")],
        max_tokens: 64,
    }
}

pub fn sse(event: &str, data: &str) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

pub const START: &str = r#"{"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":10,"output_tokens":1}}}"#;

pub fn delta(text: &str) -> String {
    sse(
        "content_block_delta",
        &format!(
            r#"{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"{text}"}}}}"#
        ),
    )
}

pub fn end() -> String {
    sse(
        "message_delta",
        r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}"#,
    ) + &sse("message_stop", r#"{"type":"message_stop"}"#)
}
