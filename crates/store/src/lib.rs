//! Local application storage (ADR-0004). Only the Rust backend touches this database; the UI goes
//! through typed commands. Secrets are never stored here (ADR-0003).

pub mod connections;
pub mod history;
mod migrations;
pub mod revisions;
pub mod snippets;
pub mod ssh;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub use connections::{
    ConnectionDraft, ConnectionProfile, Engine, Environment, Folder, SaveMode, SslMode,
};
pub use history::{HistoryEntry, HistoryQuery, HistoryRecord, HistoryStatus, Retention};
pub use migrations::LATEST_VERSION;
pub use revisions::{RevisionInfo, RevisionReason, RevisionRetention};
pub use snippets::{Snippet, SnippetDialect, SnippetDraft, SnippetFile};
pub use ssh::{SshAuthMethod, SshProfile, SshProfileDraft, TrustedHostKey};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("storage error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("could not encode stored value: {0}")]
    Json(#[from] serde_json::Error),
    #[error("migration {version} failed: {source}")]
    Migration {
        version: i64,
        source: rusqlite::Error,
    },
    #[error(
        "app.db was created by a newer version of Quarry (schema {found}, this build supports {supported})"
    )]
    NewerSchema { found: i64, supported: i64 },
    #[error("{0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

/// What a new run does with the previous run's result tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum ResultTabs {
    /// Replace them (pinned results stay).
    #[default]
    Reuse,
    /// Keep them as extra tabs, up to a limit.
    New,
}

/// What Run does when the caret is outside every statement (blank lines, trailing comments).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum OutsideStatement {
    /// Run the statement before the caret (or the first one).
    #[default]
    Nearest,
    /// Ask which statement to run.
    Ask,
}

/// What Run does with a selection that holds several statements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "lowercase")]
pub enum SelectionRun {
    /// Run all of them, in order.
    #[default]
    All,
    /// Ask: one of them, or all.
    Ask,
}

/// Application preferences. Unknown or missing fields fall back to defaults so older/newer
/// settings rows never block startup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: ThemePreference,
    pub editor_font_size: u8,
    pub result_tabs: ResultTabs,
    /// Statements running longer than this are cancelled; 0 = no limit.
    pub statement_timeout_secs: u32,
    /// Runs longer than this show a notice and notify when done; 0 = never.
    pub long_query_secs: u32,
    pub run_outside_statement: OutsideStatement,
    pub run_selection: SelectionRun,
    /// Query history entries kept per data source; the oldest go first.
    pub history_limit: u32,
    /// Query history older than this many days is removed; 0 = keep regardless of age.
    pub history_max_age_days: u32,
    /// Local history: revisions kept per console; the oldest go first.
    pub revision_limit: u32,
    /// Local history older than this many days is removed; 0 = keep regardless of age.
    pub revision_max_age_days: u32,
    /// Minutes between automatic revisions while a console is being edited.
    pub revision_interval_mins: u32,
    /// Shortcut overrides by action id; each replaces all of that action's default bindings
    /// (an empty list unbinds it). Ids the UI no longer knows are ignored there.
    pub keymap: BTreeMap<String, Vec<String>>,
}

impl Settings {
    pub const FONT_SIZE_RANGE: std::ops::RangeInclusive<u8> = 9..=32;
    /// Upper bound for the timeout and long-query thresholds (one day).
    pub const MAX_SECONDS: u32 = 86_400;
    pub const HISTORY_LIMIT_RANGE: std::ops::RangeInclusive<u32> = 100..=1_000_000;
    /// Ten years.
    pub const MAX_HISTORY_DAYS: u32 = 3_650;
    pub const REVISION_LIMIT_RANGE: std::ops::RangeInclusive<u32> = 1..=1_000;
    pub const REVISION_INTERVAL_RANGE: std::ops::RangeInclusive<u32> = 1..=240;
    pub const MAX_KEYMAP_ENTRIES: usize = 500;
    pub const MAX_BINDINGS: usize = 4;
    pub const MAX_CHORD_LEN: usize = 64;

    pub fn validate(&self) -> Result<(), StoreError> {
        if !Self::FONT_SIZE_RANGE.contains(&self.editor_font_size) {
            return Err(StoreError::Invalid(format!(
                "editor font size must be between {} and {}",
                Self::FONT_SIZE_RANGE.start(),
                Self::FONT_SIZE_RANGE.end()
            )));
        }
        if self.statement_timeout_secs > Self::MAX_SECONDS
            || self.long_query_secs > Self::MAX_SECONDS
        {
            return Err(StoreError::Invalid(format!(
                "time limits must be between 0 and {} seconds",
                Self::MAX_SECONDS
            )));
        }
        if !Self::HISTORY_LIMIT_RANGE.contains(&self.history_limit) {
            return Err(StoreError::Invalid(format!(
                "history size must be between {} and {} entries",
                Self::HISTORY_LIMIT_RANGE.start(),
                Self::HISTORY_LIMIT_RANGE.end()
            )));
        }
        if !Self::REVISION_LIMIT_RANGE.contains(&self.revision_limit)
            || self.revision_max_age_days > Self::MAX_HISTORY_DAYS
            || !Self::REVISION_INTERVAL_RANGE.contains(&self.revision_interval_mins)
        {
            return Err(StoreError::Invalid(format!(
                "local history keeps {} to {} revisions per console, at most {} days, \
                 one every {} to {} minutes",
                Self::REVISION_LIMIT_RANGE.start(),
                Self::REVISION_LIMIT_RANGE.end(),
                Self::MAX_HISTORY_DAYS,
                Self::REVISION_INTERVAL_RANGE.start(),
                Self::REVISION_INTERVAL_RANGE.end()
            )));
        }
        if self.history_max_age_days > Self::MAX_HISTORY_DAYS {
            return Err(StoreError::Invalid(format!(
                "history age must be between 0 and {} days",
                Self::MAX_HISTORY_DAYS
            )));
        }
        self.validate_keymap()
    }

    fn validate_keymap(&self) -> Result<(), StoreError> {
        let invalid = |msg: String| Err(StoreError::Invalid(msg));
        if self.keymap.len() > Self::MAX_KEYMAP_ENTRIES {
            return invalid(format!(
                "at most {} shortcut overrides",
                Self::MAX_KEYMAP_ENTRIES
            ));
        }
        for (id, chords) in &self.keymap {
            let id_ok = !id.is_empty()
                && id.len() <= Self::MAX_CHORD_LEN
                && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.');
            if !id_ok {
                return invalid(format!("invalid action id '{id}'"));
            }
            if chords.len() > Self::MAX_BINDINGS {
                return invalid(format!(
                    "{id}: at most {} shortcuts per action",
                    Self::MAX_BINDINGS
                ));
            }
            for chord in chords {
                if chord.is_empty()
                    || chord.len() > Self::MAX_CHORD_LEN
                    || chord.chars().any(char::is_control)
                {
                    return invalid(format!("{id}: invalid shortcut '{chord}'"));
                }
            }
        }
        Ok(())
    }

    /// The local history retention these settings ask for.
    pub fn revision_retention(&self) -> RevisionRetention {
        RevisionRetention {
            max_per_console: self.revision_limit,
            max_age_days: self.revision_max_age_days,
            interval_ms: i64::from(self.revision_interval_mins) * 60_000,
        }
    }

    /// The history retention these settings ask for.
    pub fn history_retention(&self) -> Retention {
        Retention {
            max_entries: self.history_limit,
            max_age_days: self.history_max_age_days,
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
            editor_font_size: 13,
            result_tabs: ResultTabs::Reuse,
            statement_timeout_secs: 0,
            long_query_secs: 20,
            run_outside_statement: OutsideStatement::Nearest,
            run_selection: SelectionRun::All,
            history_limit: 10_000,
            history_max_age_days: 0,
            revision_limit: 100,
            revision_max_age_days: 30,
            revision_interval_mins: 5,
            keymap: BTreeMap::new(),
        }
    }
}

/// Upper bound on a persisted workspace snapshot; open consoles move to files in M3.1.
pub const MAX_WORKSPACE_BYTES: usize = 8 * 1024 * 1024;

const SETTINGS_KEY: &str = "app";
const WORKSPACE_KEY: &str = "main";

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self, StoreError> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrations::migrate(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub(crate) fn conn(&self) -> MutexGuard<'_, Connection> {
        // A panic while holding the lock cannot leave SQLite in a torn state (each call is atomic),
        // so recovering the guard is safe.
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn schema_version(&self) -> Result<i64, StoreError> {
        Ok(self
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    pub fn settings(&self) -> Result<Settings, StoreError> {
        let json = self.read("settings", SETTINGS_KEY)?;
        // A corrupt row must not brick the app: fall back to defaults; the next save overwrites it.
        let settings = json
            .and_then(|j| serde_json::from_str::<Settings>(&j).ok())
            .filter(|s| s.validate().is_ok())
            .unwrap_or_default();
        Ok(settings)
    }

    pub fn set_settings(&self, settings: &Settings) -> Result<Settings, StoreError> {
        settings.validate()?;
        self.write("settings", SETTINGS_KEY, &serde_json::to_string(settings)?)?;
        Ok(settings.clone())
    }

    pub fn workspace(&self) -> Result<Option<serde_json::Value>, StoreError> {
        Ok(match self.read("workspace_state", WORKSPACE_KEY)? {
            Some(json) => serde_json::from_str(&json).ok(),
            None => None,
        })
    }

    pub fn set_workspace(&self, state: &serde_json::Value) -> Result<(), StoreError> {
        if !state.is_object() {
            return Err(StoreError::Invalid(
                "workspace state must be a JSON object".into(),
            ));
        }
        let json = serde_json::to_string(state)?;
        if json.len() > MAX_WORKSPACE_BYTES {
            return Err(StoreError::Invalid(format!(
                "workspace state is {} bytes; the limit is {MAX_WORKSPACE_BYTES}",
                json.len()
            )));
        }
        self.write("workspace_state", WORKSPACE_KEY, &json)
    }

    // `table` is always one of the compile-time constants above, never user input.
    fn read(&self, table: &'static str, key: &str) -> Result<Option<String>, StoreError> {
        let sql = format!("SELECT value_json FROM {table} WHERE key = ?1");
        Ok(self
            .conn()
            .query_row(&sql, params![key], |row| row.get(0))
            .optional()?)
    }

    fn write(&self, table: &'static str, key: &str, json: &str) -> Result<(), StoreError> {
        let sql = format!(
            "INSERT INTO {table} (key, value_json) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
        );
        self.conn().execute(&sql, params![key, json])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn migrates_fresh_database_to_latest() {
        let store = Store::open_in_memory().expect("open");
        assert_eq!(store.schema_version().expect("version"), LATEST_VERSION);
    }

    #[test]
    fn reopening_is_idempotent_and_keeps_data() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("app.db");
        {
            let store = Store::open(&path).expect("open");
            store
                .set_settings(&Settings {
                    theme: ThemePreference::Dark,
                    editor_font_size: 15,
                    ..Settings::default()
                })
                .expect("save");
        }
        let store = Store::open(&path).expect("reopen");
        assert_eq!(store.schema_version().expect("version"), LATEST_VERSION);
        assert_eq!(store.settings().expect("load").theme, ThemePreference::Dark);
    }

    #[test]
    fn refuses_database_from_newer_build() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("app.db");
        Connection::open(&path)
            .expect("raw open")
            .pragma_update(None, "user_version", LATEST_VERSION + 1)
            .expect("bump");
        assert!(matches!(
            Store::open(&path),
            Err(StoreError::NewerSchema { .. })
        ));
    }

    #[test]
    fn settings_default_then_round_trip() {
        let store = Store::open_in_memory().expect("open");
        assert_eq!(store.settings().expect("load"), Settings::default());
        let next = Settings {
            theme: ThemePreference::Light,
            editor_font_size: 20,
            ..Settings::default()
        };
        assert_eq!(store.set_settings(&next).expect("save"), next);
        assert_eq!(store.settings().expect("load"), next);
    }

    #[test]
    fn rejects_out_of_range_font_size_without_writing() {
        let store = Store::open_in_memory().expect("open");
        let bad = Settings {
            theme: ThemePreference::Dark,
            editor_font_size: 99,
            ..Settings::default()
        };
        assert!(matches!(
            store.set_settings(&bad),
            Err(StoreError::Invalid(_))
        ));
        assert_eq!(store.settings().expect("load"), Settings::default());
    }

    #[test]
    fn corrupt_or_partial_settings_fall_back_to_defaults() {
        let store = Store::open_in_memory().expect("open");
        store
            .write("settings", SETTINGS_KEY, "{not json")
            .expect("write");
        assert_eq!(store.settings().expect("load"), Settings::default());
        store
            .write("settings", SETTINGS_KEY, r#"{"theme":"dark"}"#)
            .expect("write");
        assert_eq!(
            store.settings().expect("load"),
            Settings {
                theme: ThemePreference::Dark,
                ..Settings::default()
            }
        );
    }

    #[test]
    fn time_limits_are_validated() {
        let store = Store::open_in_memory().expect("open");
        let ok = Settings {
            statement_timeout_secs: 30,
            long_query_secs: 0,
            ..Settings::default()
        };
        assert_eq!(store.set_settings(&ok).expect("save"), ok);
        let bad = Settings {
            statement_timeout_secs: Settings::MAX_SECONDS + 1,
            ..Settings::default()
        };
        assert!(matches!(
            store.set_settings(&bad),
            Err(StoreError::Invalid(_))
        ));
        assert_eq!(store.settings().expect("load"), ok);
    }

    #[test]
    fn keymap_overrides_round_trip_and_are_validated() {
        let store = Store::open_in_memory().expect("open");
        let ok = Settings {
            keymap: BTreeMap::from([
                ("query.run".to_owned(), vec!["Ctrl+R".to_owned()]),
                ("tab.close".to_owned(), vec![]),
            ]),
            ..Settings::default()
        };
        assert_eq!(store.set_settings(&ok).expect("save"), ok);
        assert_eq!(store.settings().expect("load"), ok);
        let bad = [
            BTreeMap::from([("bad id!".to_owned(), vec![])]),
            BTreeMap::from([("query.run".to_owned(), vec![String::new()])]),
            BTreeMap::from([("query.run".to_owned(), vec!["F1".to_owned(); 5])]),
            BTreeMap::from([("query.run".to_owned(), vec!["Ctrl+\n".to_owned()])]),
        ];
        for keymap in bad {
            assert!(matches!(
                store.set_settings(&Settings {
                    keymap,
                    ..Settings::default()
                }),
                Err(StoreError::Invalid(_))
            ));
        }
        assert_eq!(store.settings().expect("load"), ok);
    }

    #[test]
    fn history_retention_is_validated() {
        let store = Store::open_in_memory().expect("open");
        for bad in [
            Settings {
                history_limit: 10,
                ..Settings::default()
            },
            Settings {
                history_max_age_days: Settings::MAX_HISTORY_DAYS + 1,
                ..Settings::default()
            },
        ] {
            assert!(matches!(
                store.set_settings(&bad),
                Err(StoreError::Invalid(_))
            ));
        }
        let ok = Settings {
            history_limit: 500,
            history_max_age_days: 30,
            ..Settings::default()
        };
        assert_eq!(store.set_settings(&ok).expect("save"), ok);
        assert_eq!(
            ok.history_retention(),
            Retention {
                max_entries: 500,
                max_age_days: 30
            }
        );
    }

    #[test]
    fn settings_json_uses_frontend_field_names() {
        let json = serde_json::to_value(Settings::default()).expect("encode");
        assert_eq!(
            json,
            json!({
                "theme": "system",
                "editorFontSize": 13,
                "resultTabs": "reuse",
                "statementTimeoutSecs": 0,
                "longQuerySecs": 20,
                "runOutsideStatement": "nearest",
                "runSelection": "all",
                "historyLimit": 10000,
                "historyMaxAgeDays": 0,
                "revisionLimit": 100,
                "revisionMaxAgeDays": 30,
                "revisionIntervalMins": 5,
                "keymap": {}
            })
        );
    }

    #[test]
    fn workspace_round_trip_and_validation() {
        let store = Store::open_in_memory().expect("open");
        assert_eq!(store.workspace().expect("load"), None);
        let state = json!({ "tabs": [{ "id": "a", "title": "console", "text": "select 1;" }] });
        store.set_workspace(&state).expect("save");
        assert_eq!(store.workspace().expect("load"), Some(state));
        assert!(store.set_workspace(&json!([1, 2])).is_err());
        let huge = json!({ "text": "x".repeat(MAX_WORKSPACE_BYTES) });
        assert!(matches!(
            store.set_workspace(&huge),
            Err(StoreError::Invalid(_))
        ));
    }
}
