//! Connection profile repository. Profiles hold *where* and *how* to connect; passwords live in
//! `quarry-secrets` and only a `password_saved` flag is recorded here.

use quarry_db_core::{Isolation, TxMode};
use rusqlite::{ErrorCode, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

macro_rules! string_enum {
    ($(#[$m:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        #[cfg_attr(feature = "ts", derive(ts_rs::TS))]
        pub enum $name { $(#[serde(rename = $text)] $variant),+ }

        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
            fn parse(s: &str) -> Result<Self, StoreError> {
                match s {
                    $($text => Ok(Self::$variant),)+
                    other => Err(StoreError::Invalid(format!(
                        concat!("unknown ", stringify!($name), " '{}'"), other))),
                }
            }
        }
    };
}

string_enum!(Engine { Postgres => "postgresql" });
string_enum!(
    /// libpq-compatible TLS modes.
    SslMode {
        Disable => "disable", Prefer => "prefer", Require => "require",
        VerifyCa => "verify-ca", VerifyFull => "verify-full",
    }
);
string_enum!(
    /// Environment label; `Production` drives extra confirmations for writes.
    Environment {
        None => "none", Development => "development", Testing => "testing",
        Staging => "staging", Production => "production",
    }
);
string_enum!(
    /// Where the password is kept (ADR-0003).
    SaveMode { Never => "never", UntilRestart => "untilRestart", Forever => "forever" }
);

/// Editable fields of a profile, as sent by the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDraft {
    pub name: String,
    pub engine: Engine,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub ssl_mode: SslMode,
    pub connect_timeout_secs: u16,
    pub read_only: bool,
    pub environment: Environment,
    pub color: Option<String>,
    pub save_mode: SaveMode,
    /// Transaction mode new sessions of this data source start in.
    #[serde(default)]
    pub tx_mode: TxMode,
    /// Isolation level for transactions opened in Manual mode.
    #[serde(default)]
    pub isolation: Isolation,
    /// Record every statement run against this data source in the query history.
    #[serde(default = "history_on")]
    pub history_enabled: bool,
}

fn history_on() -> bool {
    true
}

fn tx_mode_text(m: TxMode) -> &'static str {
    match m {
        TxMode::Auto => "auto",
        TxMode::Manual => "manual",
    }
}

fn parse_tx_mode(s: &str) -> Result<TxMode, StoreError> {
    match s {
        "auto" => Ok(TxMode::Auto),
        "manual" => Ok(TxMode::Manual),
        other => Err(StoreError::Invalid(format!("unknown TxMode '{other}'"))),
    }
}

fn isolation_text(i: Isolation) -> &'static str {
    match i {
        Isolation::ReadCommitted => "read_committed",
        Isolation::RepeatableRead => "repeatable_read",
        Isolation::Serializable => "serializable",
    }
}

fn parse_isolation(s: &str) -> Result<Isolation, StoreError> {
    match s {
        "read_committed" => Ok(Isolation::ReadCommitted),
        "repeatable_read" => Ok(Isolation::RepeatableRead),
        "serializable" => Ok(Isolation::Serializable),
        other => Err(StoreError::Invalid(format!("unknown Isolation '{other}'"))),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    #[serde(flatten)]
    pub draft: ConnectionDraft,
    /// True when a password is in the OS credential store (save mode `forever`).
    pub password_saved: bool,
    pub created_at: String,
    pub updated_at: String,
}

pub const NAME_MAX: usize = 100;
pub const TIMEOUT_RANGE: std::ops::RangeInclusive<u16> = 1..=300;

impl ConnectionDraft {
    /// Trims text fields and checks every constraint; returns the normalized draft.
    pub fn normalized(mut self) -> Result<Self, StoreError> {
        let invalid = |msg: &str| Err(StoreError::Invalid(msg.to_owned()));
        self.name = self.name.trim().to_owned();
        self.host = self.host.trim().to_owned();
        self.database = self.database.trim().to_owned();
        self.username = self.username.trim().to_owned();
        self.color = self
            .color
            .map(|c| c.trim().to_ascii_lowercase())
            .filter(|c| !c.is_empty());

        if self.name.is_empty() {
            return invalid("Name is required.");
        }
        if self.name.chars().count() > NAME_MAX {
            return invalid("Name must be at most 100 characters.");
        }
        if self.host.is_empty()
            || self.host.len() > 255
            || self.host.chars().any(char::is_whitespace)
        {
            return invalid("Host must be a hostname or IP address without spaces.");
        }
        if self.port == 0 {
            return invalid("Port must be between 1 and 65535.");
        }
        if self.username.is_empty() || self.username.len() > 128 {
            return invalid("User is required (at most 128 characters).");
        }
        if self.database.len() > 128 {
            return invalid("Database name must be at most 128 characters.");
        }
        if !TIMEOUT_RANGE.contains(&self.connect_timeout_secs) {
            return invalid("Connect timeout must be between 1 and 300 seconds.");
        }
        if let Some(c) = &self.color {
            let hex = c.strip_prefix('#').unwrap_or("");
            if hex.len() != 6 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
                return invalid("Color must look like #1a2b3c.");
            }
        }
        Ok(self)
    }
}

const COLUMNS: &str = "id, name, engine, host, port, database, username, ssl_mode, \
    connect_timeout_secs, read_only, environment, color, save_mode, password_saved, created_at, updated_at, \
    tx_mode, isolation, history_enabled";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Result<ConnectionProfile, StoreError>> {
    let text = |i: usize| row.get::<_, String>(i);
    let parsed = (|| -> Result<ConnectionProfile, StoreError> {
        Ok(ConnectionProfile {
            id: text(0)?,
            draft: ConnectionDraft {
                name: text(1)?,
                engine: Engine::parse(&text(2)?)?,
                host: text(3)?,
                port: row.get(4)?,
                database: text(5)?,
                username: text(6)?,
                ssl_mode: SslMode::parse(&text(7)?)?,
                connect_timeout_secs: row.get(8)?,
                read_only: row.get(9)?,
                environment: Environment::parse(&text(10)?)?,
                color: row.get(11)?,
                save_mode: SaveMode::parse(&text(12)?)?,
                tx_mode: parse_tx_mode(&text(16)?)?,
                isolation: parse_isolation(&text(17)?)?,
                history_enabled: row.get(18)?,
            },
            password_saved: row.get(13)?,
            created_at: text(14)?,
            updated_at: text(15)?,
        })
    })();
    Ok(parsed)
}

fn map_unique(err: rusqlite::Error, name: &str) -> StoreError {
    match &err {
        rusqlite::Error::SqliteFailure(e, _) if e.code == ErrorCode::ConstraintViolation => {
            StoreError::Invalid(format!("A data source named \"{name}\" already exists."))
        }
        _ => StoreError::Sqlite(err),
    }
}

impl Store {
    pub fn list_connections(&self) -> Result<Vec<ConnectionProfile>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM connections ORDER BY name COLLATE NOCASE"
        ))?;
        let rows = stmt.query_map([], from_row)?;
        rows.map(|r| r?).collect()
    }

    pub fn get_connection(&self, id: &str) -> Result<Option<ConnectionProfile>, StoreError> {
        let conn = self.conn();
        let row = conn
            .query_row(
                &format!("SELECT {COLUMNS} FROM connections WHERE id = ?1"),
                [id],
                from_row,
            )
            .optional()?;
        row.transpose()
    }

    /// Inserts a validated draft under `id` (callers generate ids so secrets can be keyed first).
    pub fn insert_connection(
        &self,
        id: &str,
        draft: ConnectionDraft,
    ) -> Result<ConnectionProfile, StoreError> {
        let d = draft.normalized()?;
        self.conn()
            .execute(
                "INSERT INTO connections (id, name, engine, host, port, database, username, ssl_mode,
                     connect_timeout_secs, read_only, environment, color, save_mode, tx_mode, isolation,
                     history_enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    id, d.name, d.engine.as_str(), d.host, d.port, d.database, d.username,
                    d.ssl_mode.as_str(), d.connect_timeout_secs, d.read_only,
                    d.environment.as_str(), d.color, d.save_mode.as_str(),
                    tx_mode_text(d.tx_mode), isolation_text(d.isolation), d.history_enabled
                ],
            )
            .map_err(|e| map_unique(e, &d.name))?;
        self.require_connection(id)
    }

    pub fn update_connection(
        &self,
        id: &str,
        draft: ConnectionDraft,
    ) -> Result<ConnectionProfile, StoreError> {
        let d = draft.normalized()?;
        let changed = self
            .conn()
            .execute(
                "UPDATE connections SET name = ?2, engine = ?3, host = ?4, port = ?5, database = ?6,
                     username = ?7, ssl_mode = ?8, connect_timeout_secs = ?9, read_only = ?10,
                     environment = ?11, color = ?12, save_mode = ?13, tx_mode = ?14, isolation = ?15,
                     history_enabled = ?16, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1",
                params![
                    id, d.name, d.engine.as_str(), d.host, d.port, d.database, d.username,
                    d.ssl_mode.as_str(), d.connect_timeout_secs, d.read_only,
                    d.environment.as_str(), d.color, d.save_mode.as_str(),
                    tx_mode_text(d.tx_mode), isolation_text(d.isolation), d.history_enabled
                ],
            )
            .map_err(|e| map_unique(e, &d.name))?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!("data source {id}")));
        }
        self.require_connection(id)
    }

    pub fn set_password_saved(&self, id: &str, saved: bool) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE connections SET password_saved = ?2 WHERE id = ?1",
            params![id, saved],
        )?;
        Ok(())
    }

    pub fn delete_connection(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self
            .conn()
            .execute("DELETE FROM connections WHERE id = ?1", [id])?
            > 0)
    }

    /// A name not used by any profile: "Name (copy)", then "Name (copy 2)", ...
    pub fn unique_copy_name(&self, name: &str) -> Result<String, StoreError> {
        let taken: Vec<String> = self
            .list_connections()?
            .into_iter()
            .map(|c| c.draft.name.to_lowercase())
            .collect();
        let base: String = name.chars().take(NAME_MAX - 12).collect();
        let mut candidate = format!("{base} (copy)");
        let mut n = 2;
        while taken.contains(&candidate.to_lowercase()) {
            candidate = format!("{base} (copy {n})");
            n += 1;
        }
        Ok(candidate)
    }

    fn require_connection(&self, id: &str) -> Result<ConnectionProfile, StoreError> {
        self.get_connection(id)?
            .ok_or_else(|| StoreError::NotFound(format!("data source {id}")))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn draft(name: &str) -> ConnectionDraft {
        ConnectionDraft {
            name: name.into(),
            engine: Engine::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: "app".into(),
            username: "dev".into(),
            ssl_mode: SslMode::Prefer,
            connect_timeout_secs: 10,
            read_only: false,
            environment: Environment::Development,
            color: None,
            save_mode: SaveMode::Forever,
            tx_mode: TxMode::Auto,
            isolation: Isolation::ReadCommitted,
            history_enabled: true,
        }
    }

    #[test]
    fn insert_list_update_delete() {
        let store = Store::open_in_memory().expect("open");
        let created = store
            .insert_connection("a", draft("  Local  "))
            .expect("insert");
        assert_eq!(created.draft.name, "Local");
        assert!(!created.password_saved);

        let mut next = draft("Local");
        next.read_only = true;
        next.color = Some("#AABBCC".into());
        let updated = store.update_connection("a", next).expect("update");
        assert!(updated.draft.read_only);
        assert_eq!(updated.draft.color.as_deref(), Some("#aabbcc"));

        assert_eq!(store.list_connections().expect("list").len(), 1);
        assert!(store.delete_connection("a").expect("delete"));
        assert!(!store.delete_connection("a").expect("delete again"));
        assert!(matches!(
            store.update_connection("a", draft("x")),
            Err(StoreError::NotFound(_))
        ));
    }

    #[test]
    fn names_are_unique_case_insensitively() {
        let store = Store::open_in_memory().expect("open");
        store
            .insert_connection("a", draft("Prod DB"))
            .expect("insert");
        let err = store
            .insert_connection("b", draft("prod db"))
            .expect_err("dup");
        assert!(err.to_string().contains("already exists"), "{err}");
    }

    #[test]
    fn copy_names_skip_taken_ones() {
        let store = Store::open_in_memory().expect("open");
        store
            .insert_connection("a", draft("Local"))
            .expect("insert");
        assert_eq!(
            store.unique_copy_name("Local").expect("name"),
            "Local (copy)"
        );
        store
            .insert_connection("b", draft("Local (copy)"))
            .expect("insert");
        assert_eq!(
            store.unique_copy_name("Local").expect("name"),
            "Local (copy 2)"
        );
    }

    #[test]
    fn validation_rejects_bad_input() {
        type Mutation = (&'static str, fn(&mut ConnectionDraft));
        let cases: [Mutation; 7] = [
            ("Name is required", |d| d.name = "  ".into()),
            ("Host must", |d| d.host = "local host".into()),
            ("Port must", |d| d.port = 0),
            ("User is required", |d| d.username = String::new()),
            ("Connect timeout", |d| d.connect_timeout_secs = 0),
            ("Color must", |d| d.color = Some("red".into())),
            ("at most 100", |d| d.name = "x".repeat(101)),
        ];
        for (expected, mutate) in cases {
            let mut d = draft("ok");
            mutate(&mut d);
            let err = d.normalized().expect_err(expected);
            assert!(err.to_string().contains(expected), "{expected}: {err}");
        }
    }

    #[test]
    fn json_shape_matches_frontend() {
        let store = Store::open_in_memory().expect("open");
        let p = store
            .insert_connection("a", draft("Local"))
            .expect("insert");
        let json = serde_json::to_value(&p).expect("encode");
        for key in [
            "id",
            "name",
            "engine",
            "sslMode",
            "connectTimeoutSecs",
            "readOnly",
            "saveMode",
            "passwordSaved",
        ] {
            assert!(json.get(key).is_some(), "missing {key} in {json}");
        }
        assert_eq!(json["saveMode"], "forever");
        assert_eq!(json["engine"], "postgresql");
        assert_eq!(json["txMode"], "auto");
        assert_eq!(json["isolation"], "read_committed");
    }

    #[test]
    fn transaction_defaults_round_trip() {
        let store = Store::open_in_memory().expect("open");
        store
            .insert_connection("a", draft("Local"))
            .expect("insert");
        let updated = store
            .update_connection(
                "a",
                ConnectionDraft {
                    tx_mode: TxMode::Manual,
                    isolation: Isolation::Serializable,
                    ..draft("Local")
                },
            )
            .expect("update");
        assert_eq!(
            (updated.draft.tx_mode, updated.draft.isolation),
            (TxMode::Manual, Isolation::Serializable)
        );
        // Drafts from older UIs without the fields get the defaults.
        let old: ConnectionDraft = serde_json::from_value(serde_json::json!({
            "name": "x", "engine": "postgresql", "host": "h", "port": 5432, "database": "d",
            "username": "u", "sslMode": "prefer", "connectTimeoutSecs": 10, "readOnly": false,
            "environment": "none", "color": null, "saveMode": "never"
        }))
        .expect("decode");
        assert_eq!(
            (old.tx_mode, old.isolation),
            (TxMode::Auto, Isolation::ReadCommitted)
        );
    }

    #[test]
    fn upgrading_from_version_2_keeps_profiles_with_auto_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("app.db");
        {
            let mut raw = rusqlite::Connection::open(&path).expect("raw");
            crate::migrations::migrate_to(&mut raw, 2).expect("v2");
            raw.execute_batch(
                "INSERT INTO connections (id, name, engine, host, port, database, username,
                     ssl_mode, connect_timeout_secs, read_only, environment, color, save_mode)
                 VALUES ('old', 'Old', 'postgresql', 'h', 5432, 'd', 'u', 'prefer', 10, 0,
                     'none', NULL, 'never')",
            )
            .expect("v2 row");
        }
        let store = Store::open(&path).expect("upgrade");
        assert_eq!(
            store.schema_version().expect("version"),
            crate::LATEST_VERSION
        );
        let p = store.get_connection("old").expect("get").expect("kept");
        assert_eq!(
            (p.draft.tx_mode, p.draft.isolation),
            (TxMode::Auto, Isolation::ReadCommitted)
        );
    }
}
