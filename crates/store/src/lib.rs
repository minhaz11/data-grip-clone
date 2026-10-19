//! Local application storage (ADR-0004). Only the Rust backend touches this database; the UI goes
//! through typed commands. Secrets are never stored here (ADR-0003).

pub mod connections;
mod migrations;

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

pub use connections::{ConnectionDraft, ConnectionProfile, Engine, Environment, SaveMode, SslMode};
pub use migrations::LATEST_VERSION;

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
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

/// Application preferences. Unknown or missing fields fall back to defaults so older/newer
/// settings rows never block startup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: ThemePreference,
    pub editor_font_size: u8,
}

impl Settings {
    pub const FONT_SIZE_RANGE: std::ops::RangeInclusive<u8> = 9..=32;

    pub fn validate(&self) -> Result<(), StoreError> {
        if !Self::FONT_SIZE_RANGE.contains(&self.editor_font_size) {
            return Err(StoreError::Invalid(format!(
                "editor font size must be between {} and {}",
                Self::FONT_SIZE_RANGE.start(),
                Self::FONT_SIZE_RANGE.end()
            )));
        }
        Ok(())
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: ThemePreference::System,
            editor_font_size: 13,
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
    fn settings_json_uses_frontend_field_names() {
        let json = serde_json::to_value(Settings::default()).expect("encode");
        assert_eq!(json, json!({ "theme": "system", "editorFontSize": 13 }));
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
