//! Streaming delimited-text parser. Unlike a generic CSV reader it keeps whether a value was
//! quoted, so an unquoted empty value can be NULL while `""` stays an empty string (as with
//! PostgreSQL `COPY ... CSV`), and it reports the line each record starts on.

use std::io::BufRead;
use std::ops::ControlFlow;

use super::{ImportError, ImportFormat, Record};

/// Reads UTF-8 text as chars, a buffer at a time.
struct Chars<R> {
    reader: R,
    buf: String,
    pos: usize,
    /// Bytes of a char cut at a buffer boundary.
    carry: Vec<u8>,
}

impl<R: BufRead> Chars<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            buf: String::new(),
            pos: 0,
            carry: Vec::new(),
        }
    }

    fn next(&mut self) -> Result<Option<char>, ImportError> {
        loop {
            if let Some(c) = self.buf[self.pos..].chars().next() {
                self.pos += c.len_utf8();
                return Ok(Some(c));
            }
            let chunk = self.reader.fill_buf()?;
            if chunk.is_empty() {
                if self.carry.is_empty() {
                    return Ok(None);
                }
                return Err(ImportError::Invalid(
                    "the file ends inside a character".into(),
                ));
            }
            let mut bytes = std::mem::take(&mut self.carry);
            bytes.extend_from_slice(chunk);
            let n = chunk.len();
            self.reader.consume(n);
            let valid = match std::str::from_utf8(&bytes) {
                Ok(_) => bytes.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => {
                    return Err(ImportError::Invalid(
                        "the text is not valid in the chosen encoding".into(),
                    ));
                }
            };
            self.carry = bytes.split_off(valid);
            self.buf = String::from_utf8(bytes)
                .map_err(|_| ImportError::Invalid("invalid UTF-8".into()))?;
            self.pos = 0;
        }
    }
}

/// The delimiter that splits the sample's first lines most consistently.
pub fn guess_delimiter(sample: &str) -> char {
    let lines: Vec<&str> = sample.lines().filter(|l| !l.is_empty()).take(20).collect();
    let mut best = (',', 0usize);
    for d in [',', '\t', ';', '|'] {
        let counts: Vec<usize> = lines.iter().map(|l| l.matches(d).count()).collect();
        let first = counts.first().copied().unwrap_or(0);
        if first > 0 && counts.iter().all(|&c| c == first) && first > best.1 {
            best = (d, first);
        }
    }
    best.0
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    /// At the start of a field.
    Start,
    Unquoted,
    Quoted,
    /// After a quote inside a quoted field: a doubled quote, or its end.
    QuoteInQuoted,
    /// After a closing quote, before the delimiter.
    AfterQuoted,
}

/// Parses delimited records, calling `each` until it breaks.
pub fn read<R: BufRead>(
    reader: R,
    format: &ImportFormat,
    each: &mut dyn FnMut(Record) -> ControlFlow<()>,
) -> Result<(), ImportError> {
    let mut chars = Chars::new(reader);
    let (delim, quote) = (format.delimiter, format.quote);
    let escape = format.escape.filter(|&e| e != quote);
    let mut line: u64 = 1;
    let mut record_line = 1;
    let mut values: Vec<Option<String>> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut state = State::Start;
    let mut pending_cr = false;

    let finish_field = |field: &mut String, quoted: bool, values: &mut Vec<Option<String>>| {
        let mut text = std::mem::take(field);
        if !quoted {
            if format.trim {
                text = text.trim().to_owned();
            }
            if (text.is_empty() && format.empty_is_null)
                || format.null_token.as_deref() == Some(text.as_str())
            {
                values.push(None);
                return;
            }
        }
        values.push(Some(text));
    };

    loop {
        let c = chars.next()?;
        // CR LF is one line break; a lone CR is one too.
        if pending_cr {
            pending_cr = false;
            if c == Some('\n') {
                continue;
            }
        }
        let Some(c) = c else {
            break;
        };
        match state {
            State::Quoted => {
                if escape == Some(c) {
                    match chars.next()? {
                        Some(next) => {
                            if next == '\n' {
                                line += 1;
                            }
                            field.push(next);
                        }
                        None => break,
                    }
                } else if c == quote {
                    state = State::QuoteInQuoted;
                } else {
                    if c == '\n' {
                        line += 1;
                    }
                    field.push(c);
                }
                continue;
            }
            State::QuoteInQuoted if c == quote => {
                field.push(quote);
                state = State::Quoted;
                continue;
            }
            State::QuoteInQuoted => state = State::AfterQuoted,
            _ => {}
        }
        let newline = c == '\n' || c == '\r';
        if c == delim {
            finish_field(&mut field, quoted, &mut values);
            quoted = false;
            state = State::Start;
        } else if newline {
            if c == '\r' {
                pending_cr = true;
            }
            // A line with nothing on it is not a record.
            if !(state == State::Start && values.is_empty()) {
                finish_field(&mut field, quoted, &mut values);
                if each(Record {
                    line: record_line,
                    values: std::mem::take(&mut values),
                })
                .is_break()
                {
                    return Ok(());
                }
            }
            quoted = false;
            state = State::Start;
            line += 1;
            record_line = line;
        } else {
            match state {
                State::Start if c == quote => {
                    quoted = true;
                    state = State::Quoted;
                }
                State::Start if format.trim && c.is_whitespace() => {}
                State::Start | State::Unquoted => {
                    field.push(c);
                    state = State::Unquoted;
                }
                // Text after a closing quote ("a"b): kept, as most readers do.
                State::AfterQuoted => field.push(c),
                State::Quoted | State::QuoteInQuoted => unreachable!("handled above"),
            }
        }
    }
    if state == State::Quoted {
        return Err(ImportError::Syntax {
            line: record_line,
            message: "a quoted value is not closed".into(),
        });
    }
    if !(state == State::Start && values.is_empty() && field.is_empty()) {
        finish_field(&mut field, quoted, &mut values);
        let _ = each(Record {
            line: record_line,
            values,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str, format: &ImportFormat) -> Vec<Record> {
        let mut out = Vec::new();
        read(text.as_bytes(), format, &mut |r| {
            out.push(r);
            ControlFlow::Continue(())
        })
        .expect("parse");
        out
    }

    fn values(records: &[Record]) -> Vec<Vec<Option<&str>>> {
        records
            .iter()
            .map(|r| r.values.iter().map(Option::as_deref).collect())
            .collect()
    }

    #[test]
    fn quoted_fields_hold_delimiters_quotes_and_newlines() {
        let f = ImportFormat::default();
        let text = "id,note\r\n1,\"a, b\"\r\n2,\"say \"\"hi\"\"\"\n3,\"two\nlines\"\n4,plain\n";
        let records = parse(text, &f);
        assert_eq!(
            values(&records),
            [
                vec![Some("id"), Some("note")],
                vec![Some("1"), Some("a, b")],
                vec![Some("2"), Some("say \"hi\"")],
                vec![Some("3"), Some("two\nlines")],
                vec![Some("4"), Some("plain")],
            ]
        );
        // Each record knows the line it starts on, also after a value spanning two lines.
        assert_eq!(
            records.iter().map(|r| r.line).collect::<Vec<_>>(),
            [1, 2, 3, 4, 6]
        );
    }

    #[test]
    fn null_token_and_empty_values() {
        let f = ImportFormat {
            null_token: Some("\\N".into()),
            ..ImportFormat::default()
        };
        assert_eq!(
            values(&parse("a,,\"\",\\N,\"\\N\"\n", &f)),
            [vec![Some("a"), None, Some(""), None, Some("\\N")]]
        );
        let keep_empty = ImportFormat {
            empty_is_null: false,
            ..ImportFormat::default()
        };
        assert_eq!(
            values(&parse("a,,\"\"\n", &keep_empty)),
            [vec![Some("a"), Some(""), Some("")]]
        );
    }

    #[test]
    fn tabs_escapes_trim_and_blank_lines() {
        let tsv = ImportFormat {
            delimiter: '\t',
            ..ImportFormat::default()
        };
        assert_eq!(
            values(&parse("a\tb, c\n\n1\t2\n", &tsv)),
            [vec![Some("a"), Some("b, c")], vec![Some("1"), Some("2")]]
        );
        let escaped = ImportFormat {
            escape: Some('\\'),
            trim: true,
            ..ImportFormat::default()
        };
        assert_eq!(
            values(&parse("  x , \"q\\\"uote\"\n", &escaped)),
            [vec![Some("x"), Some("q\"uote")]]
        );
        // No newline at the end of the file.
        assert_eq!(
            values(&parse("1,2", &ImportFormat::default())),
            [vec![Some("1"), Some("2")]]
        );
    }

    #[test]
    fn an_unclosed_quote_names_its_line() {
        let err = read(
            "a,b\n1,\"open\n2,3\n".as_bytes(),
            &ImportFormat::default(),
            &mut |_| ControlFlow::Continue(()),
        )
        .expect_err("unclosed");
        assert!(
            matches!(err, ImportError::Syntax { line: 2, .. }),
            "{err:?}"
        );
    }

    #[test]
    fn multibyte_chars_across_buffer_boundaries() {
        let text = format!("{}\n", "ü".repeat(40_000));
        let reader = std::io::BufReader::with_capacity(7, text.as_bytes());
        let mut got = Vec::new();
        read(reader, &ImportFormat::default(), &mut |r| {
            got.push(r);
            ControlFlow::Continue(())
        })
        .expect("parse");
        assert_eq!(
            got[0].values[0].as_deref(),
            Some("ü".repeat(40_000).as_str())
        );
    }

    #[test]
    fn delimiter_guess() {
        assert_eq!(guess_delimiter("a;b;c\n1;2;3\n"), ';');
        assert_eq!(guess_delimiter("a\tb\n1\t2\n"), '\t');
        assert_eq!(guess_delimiter("a,b\n1,2\n"), ',');
        assert_eq!(guess_delimiter("single\nvalues\n"), ',');
    }
}
