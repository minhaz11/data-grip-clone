//! Helpers for generated SQL. Nothing here accepts SQL text from callers.

/// A PostgreSQL type name safe to place in a cast (`int4`, `timestamptz`, `_text`, …).
pub fn safe_type(name: &str) -> Option<&str> {
    let ok = !name.is_empty()
        && name.len() <= 63
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    ok.then_some(name)
}

/// Quotes an identifier (as `quote_ident` would, but always quoting): `a"b` → `"a""b"`.
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_and_type_allowlist() {
        assert_eq!(quote_ident("orders"), "\"orders\"");
        assert_eq!(quote_ident("Line \"Items\""), "\"Line \"\"Items\"\"\"");
        for ok in ["int4", "timestamptz", "_text", "varchar"] {
            assert!(safe_type(ok).is_some(), "{ok}");
        }
        for bad in ["", "Int4", "int4)", "a b", "x;y", "\"q\""] {
            assert!(safe_type(bad).is_none(), "{bad}");
        }
    }
}
