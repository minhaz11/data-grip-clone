//! PostgreSQL `COPY ... FROM STDIN` text format: tab-separated, `\N` for NULL, backslash escapes.

/// Appends one row in COPY text format to `out`.
pub fn encode_row<'a>(out: &mut Vec<u8>, values: impl IntoIterator<Item = Option<&'a str>>) {
    for (i, value) in values.into_iter().enumerate() {
        if i > 0 {
            out.push(b'\t');
        }
        let Some(value) = value else {
            out.extend_from_slice(b"\\N");
            continue;
        };
        for b in value.bytes() {
            match b {
                b'\\' => out.extend_from_slice(b"\\\\"),
                b'\t' => out.extend_from_slice(b"\\t"),
                b'\n' => out.extend_from_slice(b"\\n"),
                b'\r' => out.extend_from_slice(b"\\r"),
                _ => out.push(b),
            }
        }
    }
    out.push(b'\n');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_what_copy_text_format_needs() {
        let mut out = Vec::new();
        encode_row(
            &mut out,
            [Some("a\tb"), None, Some("c\\d\ne\r"), Some(""), Some("ü")],
        );
        assert_eq!(
            String::from_utf8(out).expect("utf8"),
            "a\\tb\t\\N\tc\\\\d\\ne\\r\t\tü\n"
        );
    }
}
