//! Messages API stream events to [`AiEvent`]s, and API errors to [`AiError`]s.

use quarry_ai_core::{AiError, AiEvent, StopReason, Usage};
use serde::Deserialize;

use crate::sse::SseEvent;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Wire {
    MessageStart {
        message: WireMessage,
    },
    ContentBlockDelta {
        delta: WireDelta,
    },
    MessageDelta {
        delta: WireMessageDelta,
        #[serde(default)]
        usage: Option<WireUsage>,
    },
    MessageStop {},
    Error {
        error: WireError,
    },
    /// `ping`, `content_block_start`, `content_block_stop`, and anything newer.
    #[serde(other)]
    Ignored,
}

#[derive(Deserialize)]
struct WireMessage {
    model: String,
    #[serde(default)]
    usage: Option<WireUsage>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireDelta {
    TextDelta {
        text: String,
    },
    /// Thinking, signatures, tool input: not shown in the MVP.
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct WireMessageDelta {
    #[serde(default)]
    stop_reason: Option<String>,
}

/// Every count is optional: `message_delta` repeats only some, and `null` means "not reported".
#[derive(Deserialize, Default)]
struct WireUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
}

#[derive(Deserialize)]
pub(crate) struct WireError {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub message: String,
}

/// An error response body: `{"type":"error","error":{...}}`.
#[derive(Deserialize)]
pub(crate) struct ErrorBody {
    pub error: WireError,
}

fn merge(into: &mut Usage, from: WireUsage) {
    let set = |slot: &mut u64, value: Option<u64>| {
        if let Some(v) = value {
            *slot = v;
        }
    };
    set(&mut into.input_tokens, from.input_tokens);
    set(&mut into.output_tokens, from.output_tokens);
    set(
        &mut into.cache_read_input_tokens,
        from.cache_read_input_tokens,
    );
    set(
        &mut into.cache_creation_input_tokens,
        from.cache_creation_input_tokens,
    );
}

fn stop_reason(value: &str) -> StopReason {
    match value {
        "end_turn" => StopReason::EndTurn,
        "max_tokens" => StopReason::MaxTokens,
        "stop_sequence" => StopReason::StopSequence,
        "refusal" => StopReason::Refusal,
        _ => StopReason::Other,
    }
}

/// Maps an API error (from the HTTP status, the body's `error.type`, or both) to an [`AiError`].
pub fn map_error(
    status: Option<u16>,
    kind: &str,
    message: String,
    retry_after_secs: Option<u64>,
) -> AiError {
    let message = if message.is_empty() {
        match status {
            Some(s) => format!("HTTP {s}"),
            None => kind.to_owned(),
        }
    } else {
        message
    };
    match (kind, status) {
        ("authentication_error", _) | (_, Some(401)) => AiError::Auth(message),
        ("permission_error" | "billing_error", _) | (_, Some(402 | 403)) => {
            AiError::Permission(message)
        }
        ("not_found_error", _) | (_, Some(404)) => AiError::NotFound(message),
        ("rate_limit_error", _) | (_, Some(429)) => AiError::RateLimited { retry_after_secs },
        ("overloaded_error", _) | (_, Some(529)) => AiError::Overloaded,
        ("timeout_error", _) | (_, Some(408 | 504)) => AiError::Timeout,
        ("invalid_request_error" | "request_too_large", _) | (_, Some(400 | 413 | 422)) => {
            AiError::InvalidRequest(message)
        }
        _ => AiError::Server(message),
    }
}

/// Turns stream events into [`AiEvent`]s. Feed every SSE event; after `message_stop` it reports
/// [`Decoder::finished`].
#[derive(Debug, Default)]
pub struct Decoder {
    usage: Usage,
    stop: Option<StopReason>,
    finished: bool,
}

impl Decoder {
    pub fn finished(&self) -> bool {
        self.finished
    }

    pub fn decode(&mut self, event: &SseEvent) -> Result<Option<AiEvent>, AiError> {
        if event.data.is_empty() {
            return Ok(None);
        }
        let wire: Wire = serde_json::from_str(&event.data).map_err(|e| {
            AiError::Protocol(format!(
                "could not read a {} event: {e}",
                event.event.as_deref().unwrap_or("stream")
            ))
        })?;
        Ok(match wire {
            Wire::MessageStart { message } => {
                merge(&mut self.usage, message.usage.unwrap_or_default());
                Some(AiEvent::Started {
                    model: message.model,
                })
            }
            Wire::ContentBlockDelta {
                delta: WireDelta::TextDelta { text },
            } => Some(AiEvent::Text { text }),
            Wire::ContentBlockDelta { .. } | Wire::Ignored => None,
            Wire::MessageDelta { delta, usage } => {
                if let Some(reason) = delta.stop_reason {
                    self.stop = Some(stop_reason(&reason));
                }
                merge(&mut self.usage, usage.unwrap_or_default());
                None
            }
            Wire::MessageStop {} => {
                self.finished = true;
                Some(AiEvent::Done {
                    stop_reason: self.stop,
                    usage: self.usage,
                })
            }
            Wire::Error { error } => return Err(map_error(None, &error.kind, error.message, None)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sse::SseParser;

    /// A recorded stream, shaped like the API's, including a ping, a thinking block and an
    /// unknown event type.
    const STREAM: &str = concat!(
        "event: message_start\n",
        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-5-5\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":12,\"output_tokens\":1,\"cache_read_input_tokens\":null}}}\n\n",
        "event: ping\n",
        "data: {\"type\":\"ping\"}\n\n",
        "event: content_block_start\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"abc\"}}\n\n",
        "event: content_block_start\n",
        "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"SELECT \"}}\n\n",
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"1;\"}}\n\n",
        "event: something_new\n",
        "data: {\"type\":\"something_new\",\"x\":1}\n\n",
        "event: content_block_stop\n",
        "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
        "event: message_delta\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":9}}\n\n",
        "event: message_stop\n",
        "data: {\"type\":\"message_stop\"}\n\n",
    );

    fn decode_all(chunks: &[&[u8]]) -> Vec<Result<AiEvent, AiError>> {
        let mut parser = SseParser::default();
        let mut decoder = Decoder::default();
        let mut out = Vec::new();
        for chunk in chunks {
            for event in parser.push(chunk).expect("sse") {
                match decoder.decode(&event) {
                    Ok(Some(e)) => out.push(Ok(e)),
                    Ok(None) => {}
                    Err(e) => out.push(Err(e)),
                }
            }
        }
        out
    }

    #[test]
    fn decodes_a_stream_into_text_and_usage() {
        let events = decode_all(&[STREAM.as_bytes()]);
        assert_eq!(
            events,
            vec![
                Ok(AiEvent::Started {
                    model: "claude-sonnet-5-5".into()
                }),
                Ok(AiEvent::Text {
                    text: "SELECT ".into()
                }),
                Ok(AiEvent::Text { text: "1;".into() }),
                Ok(AiEvent::Done {
                    stop_reason: Some(StopReason::EndTurn),
                    usage: Usage {
                        input_tokens: 12,
                        output_tokens: 9,
                        ..Usage::default()
                    }
                }),
            ]
        );
    }

    #[test]
    fn split_chunks_decode_the_same() {
        let bytes = STREAM.as_bytes();
        let whole = decode_all(&[bytes]);
        for size in [1, 2, 3, 7, 64, 333] {
            let chunks: Vec<&[u8]> = bytes.chunks(size).collect();
            assert_eq!(decode_all(&chunks), whole, "chunks of {size}");
        }
    }

    #[test]
    fn error_events_become_typed_errors() {
        let overloaded = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
        assert_eq!(
            decode_all(&[overloaded.as_bytes()]),
            vec![Err(AiError::Overloaded)]
        );
        let mid_stream = format!(
            "{}event: error\ndata: {{\"type\":\"error\",\"error\":{{\"type\":\"api_error\",\"message\":\"Internal\"}}}}\n\n",
            STREAM
                .split("event: content_block_stop")
                .next()
                .expect("prefix")
        );
        let events = decode_all(&[mid_stream.as_bytes()]);
        assert_eq!(
            events.last(),
            Some(&Err(AiError::Server("Internal".into())))
        );
        assert!(matches!(events[1], Ok(AiEvent::Text { .. })));
    }

    #[test]
    fn refusal_and_unknown_stop_reasons() {
        let mut d = Decoder::default();
        let ev = |data: &str| SseEvent {
            event: None,
            data: data.into(),
        };
        d.decode(&ev(
            r#"{"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":0}}"#,
        ))
        .expect("delta");
        assert_eq!(
            d.decode(&ev(r#"{"type":"message_stop"}"#)).expect("stop"),
            Some(AiEvent::Done {
                stop_reason: Some(StopReason::Refusal),
                usage: Usage::default()
            })
        );
        assert!(d.finished());
        let mut d = Decoder::default();
        d.decode(&ev(
            r#"{"type":"message_delta","delta":{"stop_reason":"brand_new"}}"#,
        ))
        .expect("delta");
        assert!(matches!(
            d.decode(&ev(r#"{"type":"message_stop"}"#)),
            Ok(Some(AiEvent::Done {
                stop_reason: Some(StopReason::Other),
                ..
            }))
        ));
    }

    #[test]
    fn garbage_is_a_protocol_error() {
        let mut d = Decoder::default();
        let err = d
            .decode(&SseEvent {
                event: Some("message_start".into()),
                data: "{not json".into(),
            })
            .expect_err("garbage");
        assert_eq!(err.kind(), "ai_protocol");
    }

    #[test]
    fn maps_status_codes_and_error_types() {
        let m = |status, kind: &str| map_error(status, kind, "m".into(), Some(3));
        assert_eq!(
            m(Some(401), "authentication_error"),
            AiError::Auth("m".into())
        );
        assert_eq!(m(Some(403), ""), AiError::Permission("m".into()));
        assert_eq!(
            m(Some(402), "billing_error"),
            AiError::Permission("m".into())
        );
        assert_eq!(m(Some(404), ""), AiError::NotFound("m".into()));
        assert_eq!(
            m(Some(429), "rate_limit_error"),
            AiError::RateLimited {
                retry_after_secs: Some(3)
            }
        );
        assert_eq!(m(Some(529), "overloaded_error"), AiError::Overloaded);
        assert_eq!(m(None, "overloaded_error"), AiError::Overloaded);
        assert_eq!(m(Some(400), ""), AiError::InvalidRequest("m".into()));
        assert_eq!(m(Some(500), "api_error"), AiError::Server("m".into()));
        assert_eq!(m(Some(504), ""), AiError::Timeout);
        assert_eq!(
            map_error(Some(502), "", String::new(), None),
            AiError::Server("HTTP 502".into())
        );
    }
}
