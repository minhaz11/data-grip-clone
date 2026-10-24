//! AI settings (ADR-0005): the global switch, the model, workspaces where AI stays off, and the
//! ignore list of tables and columns that must never be sent. The API key is not here: it lives in
//! the OS keyring (ADR-0003).

use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

const AI_SETTINGS_KEY: &str = "ai";

/// The current Claude Sonnet model; the provider crate checks it offers this one.
pub const DEFAULT_AI_MODEL: &str = "claude-sonnet-5-5";

/// What an ignore rule's pattern is matched against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum AiIgnoreKind {
    /// `table` or `schema.table`.
    Table,
    /// `column`, `table.column` or `schema.table.column`.
    Column,
}

/// One entry of the ignore list. Patterns are case-insensitive; `*` matches any run of characters
/// and `?` one character, within a name part (never across a dot).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct AiIgnoreRule {
    pub kind: AiIgnoreKind,
    pub pattern: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// The kill switch: while false, no AI request leaves the app.
    pub enabled: bool,
    pub model: String,
    /// Workspaces where AI stays off even when it is enabled.
    pub disabled_workspaces: Vec<String>,
    pub ignore: Vec<AiIgnoreRule>,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            model: DEFAULT_AI_MODEL.into(),
            disabled_workspaces: Vec::new(),
            ignore: Vec::new(),
        }
    }
}

fn glob(pattern: &[char], name: &[char]) -> bool {
    match pattern.split_first() {
        None => name.is_empty(),
        Some(('*', rest)) => (0..=name.len()).any(|skip| glob(rest, &name[skip..])),
        Some(('?', rest)) => !name.is_empty() && glob(rest, &name[1..]),
        Some((c, rest)) => name.first() == Some(c) && glob(rest, &name[1..]),
    }
}

fn lower_chars(s: &str) -> Vec<char> {
    s.chars().flat_map(char::to_lowercase).collect()
}

impl AiIgnoreRule {
    fn parts(&self) -> Vec<&str> {
        self.pattern.trim().split('.').collect()
    }

    fn max_parts(&self) -> usize {
        match self.kind {
            AiIgnoreKind::Table => 2,
            AiIgnoreKind::Column => 3,
        }
    }

    /// Whether the pattern matches the end of `name` (outermost part first).
    fn matches(&self, name: &[&str]) -> bool {
        let parts = self.parts();
        if parts.len() > name.len() {
            return false;
        }
        let tail = &name[name.len() - parts.len()..];
        parts
            .iter()
            .zip(tail)
            .all(|(p, n)| glob(&lower_chars(p), &lower_chars(n)))
    }
}

impl AiSettings {
    pub const MAX_IGNORE_RULES: usize = 1_000;
    pub const MAX_PATTERN_LEN: usize = 200;
    pub const MAX_WORKSPACES: usize = 100;
    pub const MAX_MODEL_LEN: usize = 100;

    /// Whether AI may send requests from `workspace_id`.
    pub fn active_in(&self, workspace_id: &str) -> bool {
        self.enabled && !self.disabled_workspaces.iter().any(|w| w == workspace_id)
    }

    /// A table listed by a `table` rule is never sent, nor are any of its columns.
    pub fn ignores_table(&self, schema: &str, table: &str) -> bool {
        self.ignore
            .iter()
            .any(|r| r.kind == AiIgnoreKind::Table && r.matches(&[schema, table]))
    }

    pub fn ignores_column(&self, schema: &str, table: &str, column: &str) -> bool {
        self.ignores_table(schema, table)
            || self
                .ignore
                .iter()
                .any(|r| r.kind == AiIgnoreKind::Column && r.matches(&[schema, table, column]))
    }

    pub fn validate(&self) -> Result<(), StoreError> {
        let invalid = |m: String| Err(StoreError::Invalid(m));
        let model_ok = !self.model.is_empty()
            && self.model.len() <= Self::MAX_MODEL_LEN
            && self
                .model
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-._:@".contains(c));
        if !model_ok {
            return invalid(format!("'{}' is not a model id", self.model));
        }
        if self.disabled_workspaces.len() > Self::MAX_WORKSPACES {
            return invalid(format!(
                "AI can be turned off in at most {} workspaces",
                Self::MAX_WORKSPACES
            ));
        }
        if self.ignore.len() > Self::MAX_IGNORE_RULES {
            return invalid(format!(
                "the ignore list holds at most {} entries",
                Self::MAX_IGNORE_RULES
            ));
        }
        for rule in &self.ignore {
            let pattern = rule.pattern.trim();
            let parts = rule.parts();
            let ok = !pattern.is_empty()
                && pattern.len() <= Self::MAX_PATTERN_LEN
                && !pattern.chars().any(char::is_control)
                && parts.len() <= rule.max_parts()
                && parts.iter().all(|p| !p.is_empty());
            if !ok {
                let shape = match rule.kind {
                    AiIgnoreKind::Table => "table or schema.table",
                    AiIgnoreKind::Column => "column, table.column or schema.table.column",
                };
                return invalid(format!(
                    "ignore pattern '{}' must look like {shape}",
                    rule.pattern
                ));
            }
        }
        Ok(())
    }
}

impl Store {
    pub fn ai_settings(&self) -> Result<AiSettings, StoreError> {
        // Like the other settings: a corrupt row falls back to defaults, which keep AI off.
        Ok(self
            .read("settings", AI_SETTINGS_KEY)?
            .and_then(|j| serde_json::from_str::<AiSettings>(&j).ok())
            .filter(|s| s.validate().is_ok())
            .unwrap_or_default())
    }

    pub fn set_ai_settings(&self, settings: &AiSettings) -> Result<AiSettings, StoreError> {
        settings.validate()?;
        let mut clean = settings.clone();
        for rule in &mut clean.ignore {
            rule.pattern = rule.pattern.trim().to_owned();
        }
        self.write("settings", AI_SETTINGS_KEY, &serde_json::to_string(&clean)?)?;
        Ok(clean)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(kind: AiIgnoreKind, pattern: &str) -> AiIgnoreRule {
        AiIgnoreRule {
            kind,
            pattern: pattern.into(),
        }
    }

    #[test]
    fn defaults_keep_ai_off() {
        let store = Store::open_in_memory().expect("store");
        let s = store.ai_settings().expect("load");
        assert_eq!(s, AiSettings::default());
        assert!(!s.enabled);
        assert!(!s.active_in("main"));
        assert_eq!(s.model, DEFAULT_AI_MODEL);
    }

    #[test]
    fn round_trip_and_workspace_switch() {
        let store = Store::open_in_memory().expect("store");
        let s = AiSettings {
            enabled: true,
            model: "claude-opus-5-5".into(),
            disabled_workspaces: vec!["other".into()],
            ignore: vec![rule(AiIgnoreKind::Table, "  billing.* ")],
        };
        let saved = store.set_ai_settings(&s).expect("save");
        assert_eq!(saved.ignore[0].pattern, "billing.*");
        assert_eq!(store.ai_settings().expect("load"), saved);
        assert!(saved.active_in("main"));
        assert!(!saved.active_in("other"));
        // The general settings row is separate and unaffected.
        assert_eq!(store.settings().expect("load"), crate::Settings::default());
    }

    #[test]
    fn ignore_rules_match_tables_and_columns() {
        let s = AiSettings {
            ignore: vec![
                rule(AiIgnoreKind::Table, "billing.*"),
                rule(AiIgnoreKind::Table, "Secrets"),
                rule(AiIgnoreKind::Column, "*password*"),
                rule(AiIgnoreKind::Column, "users.ssn"),
                rule(AiIgnoreKind::Column, "hr.staff.salar?"),
            ],
            ..AiSettings::default()
        };
        assert!(s.ignores_table("billing", "invoices"));
        assert!(!s.ignores_table("public", "billing"));
        assert!(s.ignores_table("public", "secrets"), "case-insensitive");
        assert!(s.ignores_table("any", "SECRETS"));
        assert!(!s.ignores_table("public", "orders"));
        // Columns of an ignored table are ignored too.
        assert!(s.ignores_column("billing", "invoices", "total"));
        assert!(s.ignores_column("public", "users", "password_hash"));
        assert!(s.ignores_column("public", "users", "SSN"));
        assert!(!s.ignores_column("public", "customers", "ssn"));
        assert!(s.ignores_column("hr", "staff", "salary"));
        assert!(!s.ignores_column("hr", "staff", "salaries"));
        assert!(!s.ignores_column("public", "staff", "salary"));
        assert!(!s.ignores_column("public", "users", "email"));
        // A star never crosses a dot.
        let star = AiSettings {
            ignore: vec![rule(AiIgnoreKind::Table, "a*")],
            ..AiSettings::default()
        };
        assert!(star.ignores_table("x", "audit"));
        assert!(!star.ignores_table("audit", "x"));
    }

    #[test]
    fn rejects_bad_values_without_writing() {
        let store = Store::open_in_memory().expect("store");
        let bad = [
            AiSettings {
                model: String::new(),
                ..AiSettings::default()
            },
            AiSettings {
                model: "claude sonnet".into(),
                ..AiSettings::default()
            },
            AiSettings {
                ignore: vec![rule(AiIgnoreKind::Table, "a.b.c")],
                ..AiSettings::default()
            },
            AiSettings {
                ignore: vec![rule(AiIgnoreKind::Column, "a..b")],
                ..AiSettings::default()
            },
            AiSettings {
                ignore: vec![rule(AiIgnoreKind::Column, "  ")],
                ..AiSettings::default()
            },
            AiSettings {
                ignore: vec![rule(AiIgnoreKind::Table, "a\nb")],
                ..AiSettings::default()
            },
        ];
        for s in bad {
            assert!(
                matches!(store.set_ai_settings(&s), Err(StoreError::Invalid(_))),
                "{s:?}"
            );
        }
        assert_eq!(store.ai_settings().expect("load"), AiSettings::default());
    }

    #[test]
    fn json_uses_frontend_field_names() {
        let json = serde_json::to_value(AiSettings {
            ignore: vec![rule(AiIgnoreKind::Column, "x")],
            ..AiSettings::default()
        })
        .expect("encode");
        assert_eq!(
            json,
            serde_json::json!({
                "enabled": false,
                "model": "claude-sonnet-5-5",
                "disabledWorkspaces": [],
                "ignore": [{"kind": "column", "pattern": "x"}],
            })
        );
    }
}
