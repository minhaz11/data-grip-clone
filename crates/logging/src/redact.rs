//! Scrubs secrets from log text. Applied to every formatted event before it is written, so a secret
//! is removed however it got into the message: a field, `Debug` output, or a driver error string.

use std::borrow::Cow;
use std::sync::LazyLock;

use regex::Regex;

/// Replacement for every redacted value.
pub const MASK: &str = "***";

/// Field and parameter names whose values are always secret.
const SECRET_NAMES: &str = r"password|passwd|pwd|secret|token|api[_-]?key|passphrase|authorization";

struct Rule {
    pattern: Regex,
    replacement: &'static str,
}

fn rule(pattern: &str, replacement: &'static str) -> Rule {
    Rule {
        pattern: Regex::new(pattern).expect("valid redaction pattern"),
        replacement,
    }
}

static RULES: LazyLock<Vec<Rule>> = LazyLock::new(|| {
    vec![
        // Credentials in URLs and connection strings: scheme://user:secret@host
        rule(
            r"(?i)\b([a-z][a-z0-9+.-]*://[^\s:/@]*):[^\s@/]*@",
            "${1}:***@",
        ),
        // JSON-style "password": "value"
        rule(
            &format!(r#"(?i)("(?:{SECRET_NAMES})"\s*:\s*)"(?:[^"\\]|\\.)*""#),
            r#"${1}"***""#,
        ),
        // key=value, key: value, key = "value" (tracing fields, libpq-style DSNs, query strings)
        rule(
            &format!(
                r#"(?i)\b((?:{SECRET_NAMES})\s*[=:]\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;&)}}\]]+)"#
            ),
            "${1}***",
        ),
        // Anthropic-style API keys anywhere in the text.
        rule(r"\bsk-ant-[A-Za-z0-9_-]{6,}", "sk-ant-***"),
    ]
});

/// Returns `text` with every secret replaced by [`MASK`]; borrows when nothing matched.
pub fn redact(text: &str) -> Cow<'_, str> {
    let mut out = Cow::Borrowed(text);
    for rule in RULES.iter() {
        if let Cow::Owned(replaced) = rule.pattern.replace_all(&out, rule.replacement) {
            out = Cow::Owned(replaced);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CANARY: &str = "Canary-Secret-42";

    fn assert_clean(input: &str) -> String {
        let out = redact(input).into_owned();
        assert!(!out.contains(CANARY), "secret survived: {out}");
        out
    }

    #[test]
    fn masks_url_credentials() {
        let out = assert_clean(&format!(
            "dial postgres://alice:{CANARY}@db.local:5432/app failed"
        ));
        assert_eq!(out, "dial postgres://alice:***@db.local:5432/app failed");
        // No password part: unchanged.
        assert!(matches!(
            redact("postgres://alice@db.local/app"),
            Cow::Borrowed(_)
        ));
    }

    #[test]
    fn masks_key_value_fields() {
        assert_eq!(
            assert_clean(&format!("password={CANARY} user=alice")),
            "password=*** user=alice"
        );
        assert_eq!(
            assert_clean(&format!("api_key: {CANARY}, next")),
            "api_key: ***, next"
        );
        assert_eq!(
            assert_clean(&format!(r#"secret="{CANARY} with spaces""#)),
            "secret=***"
        );
        assert_eq!(
            assert_clean(&format!("host=h password='{CANARY}' port=5")),
            "host=h password=*** port=5"
        );
        assert_eq!(assert_clean(&format!("Token={CANARY}")), "Token=***");
    }

    #[test]
    fn masks_json_fields() {
        let out = assert_clean(&format!(
            r#"{{"name":"dev","password":"{CANARY}","port":5432}}"#
        ));
        assert_eq!(out, r#"{"name":"dev","password":"***","port":5432}"#);
    }

    #[test]
    fn masks_api_keys_anywhere() {
        let out = assert_clean("auth failed for sk-ant-api03-AbC_dEf-123456789 (401)");
        assert_eq!(out, "auth failed for sk-ant-*** (401)");
    }

    #[test]
    fn leaves_ordinary_text_alone() {
        let text = "connected to db.local:5432 as alice (tls=true, latency_ms=12)";
        assert!(matches!(redact(text), Cow::Borrowed(_)));
        // Words that merely contain a secret name are not keys.
        assert!(matches!(
            redact("passwordless login enabled"),
            Cow::Borrowed(_)
        ));
    }
}
