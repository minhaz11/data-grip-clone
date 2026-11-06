//! Incremental server-sent events parser. Network chunks split lines, events and even UTF-8
//! characters anywhere, so bytes are buffered until a whole line is in.

/// One dispatched event: the `event:` name (if any) and the joined `data:` lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
}

/// A stream that never ends a line is not SSE; stop buffering at this size.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
    /// The previous chunk ended with `\r`; a `\n` at the start of this one belongs to it.
    after_cr: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct LineTooLong;

impl SseParser {
    /// Feeds a chunk; returns every event it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<SseEvent>, LineTooLong> {
        let mut out = Vec::new();
        let mut bytes = chunk;
        if self.after_cr {
            self.after_cr = false;
            if let Some(rest) = bytes.strip_prefix(b"\n") {
                bytes = rest;
            }
        }
        while let Some(at) = bytes.iter().position(|b| *b == b'\n' || *b == b'\r') {
            self.buf.extend_from_slice(&bytes[..at]);
            let line = std::mem::take(&mut self.buf);
            self.line(&String::from_utf8_lossy(&line), &mut out);
            let crlf = bytes[at] == b'\r';
            bytes = &bytes[at + 1..];
            if crlf {
                match bytes.first() {
                    Some(b'\n') => bytes = &bytes[1..],
                    None => self.after_cr = true,
                    Some(_) => {}
                }
            }
        }
        self.buf.extend_from_slice(bytes);
        if self.buf.len() > MAX_LINE_BYTES {
            return Err(LineTooLong);
        }
        Ok(out)
    }

    fn line(&mut self, line: &str, out: &mut Vec<SseEvent>) {
        if line.is_empty() {
            if !self.data.is_empty() || self.event.is_some() {
                out.push(SseEvent {
                    event: self.event.take(),
                    data: std::mem::take(&mut self.data).join("\n"),
                });
            }
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = Some(value.to_owned()),
            "data" => self.data.push(value.to_owned()),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(chunks: &[&[u8]]) -> Vec<SseEvent> {
        let mut p = SseParser::default();
        chunks
            .iter()
            .flat_map(|c| p.push(c).expect("parse"))
            .collect()
    }

    fn ev(event: &str, data: &str) -> SseEvent {
        SseEvent {
            event: Some(event.into()),
            data: data.into(),
        }
    }

    const STREAM: &str =
        "event: message_start\ndata: {\"a\":1}\n\n: comment\nevent: ping\ndata: {}\n\n";

    #[test]
    fn parses_whole_events() {
        assert_eq!(
            all(&[STREAM.as_bytes()]),
            vec![ev("message_start", "{\"a\":1}"), ev("ping", "{}")]
        );
    }

    #[test]
    fn any_split_gives_the_same_events() {
        let bytes = STREAM.as_bytes();
        let whole = all(&[bytes]);
        for at in 0..bytes.len() {
            assert_eq!(all(&[&bytes[..at], &bytes[at..]]), whole, "split at {at}");
        }
        let one_by_one: Vec<&[u8]> = bytes.chunks(1).collect();
        assert_eq!(all(&one_by_one), whole);
    }

    #[test]
    fn crlf_and_cr_line_endings() {
        let crlf = "event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r";
        let expected = vec![ev("a", "1"), ev("b", "2")];
        assert_eq!(all(&[crlf.as_bytes()]), expected);
        // A CRLF split between chunks is one line ending, not two.
        let bytes = crlf.as_bytes();
        for at in 0..bytes.len() {
            assert_eq!(
                all(&[&bytes[..at], &bytes[at..]]),
                expected,
                "split at {at}"
            );
        }
    }

    #[test]
    fn utf8_split_inside_a_character() {
        let text = "event: t\ndata: {\"text\":\"héllo ✓\"}\n\n".as_bytes();
        let at = text.iter().position(|b| *b == 0xC3).expect("é") + 1;
        assert_eq!(
            all(&[&text[..at], &text[at..]]),
            vec![ev("t", "{\"text\":\"héllo ✓\"}")]
        );
    }

    #[test]
    fn multi_line_data_and_no_space_after_colon() {
        assert_eq!(
            all(&[b"data:a\ndata: b\n\n"]),
            vec![SseEvent {
                event: None,
                data: "a\nb".into()
            }]
        );
    }

    #[test]
    fn incomplete_event_waits_for_the_blank_line() {
        let mut p = SseParser::default();
        assert!(p.push(b"event: x\ndata: 1\n").expect("parse").is_empty());
        assert_eq!(p.push(b"\n").expect("parse"), vec![ev("x", "1")]);
    }

    #[test]
    fn refuses_endless_lines() {
        let mut p = SseParser::default();
        let big = vec![b'a'; MAX_LINE_BYTES + 1];
        assert_eq!(p.push(&big), Err(LineTooLong));
    }
}
