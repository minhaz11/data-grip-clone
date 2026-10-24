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
            pub(crate) fn parse(s: &str) -> Result<Self, StoreError> {
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
    /// Folder in the Database Explorer; `None` is the top level.
    #[serde(default)]
    pub folder_id: Option<String>,
    /// Connect through this SSH profile's tunnel; `None` connects directly.
    #[serde(default)]
    pub ssh_profile_id: Option<String>,
    /// PEM files (absolute paths) read at connect time: trusted CA, client certificate and key.
    #[serde(default)]
    pub tls_ca_file: Option<String>,
    #[serde(default)]
    pub tls_cert_file: Option<String>,
    #[serde(default)]
    pub tls_key_file: Option<String>,
    /// TCP keep-alive idle time in seconds; 0 keeps the system default.
    #[serde(default)]
    pub keepalive_secs: u32,
    /// Disconnect after this many idle minutes (no statement, no open transaction); 0 = never.
    #[serde(default)]
    pub auto_disconnect_mins: u32,
    /// Statements run after every connect.
    #[serde(default)]
    pub startup_sql: String,
    /// Schemas the explorer and completion load; empty with an empty pattern means all.
    #[serde(default)]
    pub schema_names: Vec<String>,
    /// Comma-separated wildcard patterns (`*`, `?`) for more schemas, e.g. `app_*`.
    #[serde(default)]
    pub schema_pattern: String,
    /// The dialog shows the connection as a single URL instead of separate fields.
    #[serde(default)]
    pub url_only: bool,
}

fn history_on() -> bool {
    true
}

/// A new PostgreSQL data source on localhost, as the New dialog starts it (the name is empty).
impl Default for ConnectionDraft {
    fn default() -> Self {
        Self {
            name: String::new(),
            engine: Engine::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: "postgres".into(),
            username: "postgres".into(),
            ssl_mode: SslMode::Prefer,
            connect_timeout_secs: 10,
            read_only: false,
            environment: Environment::None,
            color: None,
            save_mode: SaveMode::Forever,
            tx_mode: TxMode::Auto,
            isolation: Isolation::ReadCommitted,
            history_enabled: true,
            folder_id: None,
            ssh_profile_id: None,
            tls_ca_file: None,
            tls_cert_file: None,
            tls_key_file: None,
            keepalive_secs: 0,
            auto_disconnect_mins: 0,
            startup_sql: String::new(),
            schema_names: Vec::new(),
            schema_pattern: String::new(),
            url_only: false,
        }
    }
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
    /// Position within its folder (explorer order).
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// A Database Explorer folder. Data sources in it inherit its color unless they set their own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
}

pub const NAME_MAX: usize = 100;
pub const TIMEOUT_RANGE: std::ops::RangeInclusive<u16> = 1..=300;
pub const KEEPALIVE_MAX_SECS: u32 = 3_600;
/// One day.
pub const AUTO_DISCONNECT_MAX_MINS: u32 = 1_440;
pub const STARTUP_SQL_MAX: usize = 64 * 1024;
pub const SCHEMA_NAMES_MAX: usize = 1_000;
pub const PATH_MAX: usize = 4_096;

/// A trimmed color like `#1a2b3c` (lowercase), or `None` when empty.
pub(crate) fn normalize_color(color: Option<String>) -> Result<Option<String>, StoreError> {
    let color = color
        .map(|c| c.trim().to_ascii_lowercase())
        .filter(|c| !c.is_empty());
    if let Some(c) = &color {
        let hex = c.strip_prefix('#').unwrap_or("");
        if hex.len() != 6 || !hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
            return Err(StoreError::Invalid("Color must look like #1a2b3c.".into()));
        }
    }
    Ok(color)
}

pub(crate) fn normalize_name(name: &str, what: &str) -> Result<String, StoreError> {
    let name = name.trim().to_owned();
    if name.is_empty() {
        return Err(StoreError::Invalid(format!("{what} is required.")));
    }
    if name.chars().count() > NAME_MAX {
        return Err(StoreError::Invalid(format!(
            "{what} must be at most {NAME_MAX} characters."
        )));
    }
    Ok(name)
}

/// An optional absolute file path, trimmed; empty means none.
fn normalize_path(path: Option<String>, label: &str) -> Result<Option<String>, StoreError> {
    let path = path.map(|p| p.trim().to_owned()).filter(|p| !p.is_empty());
    if let Some(p) = &path
        && (p.len() > PATH_MAX || !std::path::Path::new(p).is_absolute())
    {
        return Err(StoreError::Invalid(format!(
            "{label} must be an absolute file path."
        )));
    }
    Ok(path)
}

impl ConnectionDraft {
    /// Trims text fields and checks every constraint; returns the normalized draft.
    pub fn normalized(mut self) -> Result<Self, StoreError> {
        let invalid = |msg: &str| Err(StoreError::Invalid(msg.to_owned()));
        self.name = normalize_name(&self.name, "Name")?;
        self.host = self.host.trim().to_owned();
        self.database = self.database.trim().to_owned();
        self.username = self.username.trim().to_owned();
        self.color = normalize_color(self.color)?;
        self.folder_id = self.folder_id.filter(|f| !f.is_empty());
        self.ssh_profile_id = self.ssh_profile_id.filter(|f| !f.is_empty());
        self.tls_ca_file = normalize_path(self.tls_ca_file, "CA file")?;
        self.tls_cert_file = normalize_path(self.tls_cert_file, "Client certificate")?;
        self.tls_key_file = normalize_path(self.tls_key_file, "Client key")?;
        self.schema_pattern = self.schema_pattern.trim().to_owned();
        let mut names: Vec<String> = self
            .schema_names
            .iter()
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty())
            .collect();
        names.sort();
        names.dedup();
        self.schema_names = names;

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
        if self.tls_cert_file.is_some() != self.tls_key_file.is_some() {
            return invalid("A client certificate and its key file go together: choose both.");
        }
        if self.keepalive_secs > KEEPALIVE_MAX_SECS {
            return invalid("Keep-alive must be between 0 and 3600 seconds.");
        }
        if self.auto_disconnect_mins > AUTO_DISCONNECT_MAX_MINS {
            return invalid("Auto-disconnect must be between 0 and 1440 minutes.");
        }
        if self.startup_sql.len() > STARTUP_SQL_MAX {
            return invalid("Startup SQL must be at most 64 KB.");
        }
        if self.schema_names.len() > SCHEMA_NAMES_MAX
            || self.schema_names.iter().any(|n| n.len() > 128)
        {
            return invalid("Choose at most 1000 schemas (names up to 128 characters).");
        }
        if self.schema_pattern.len() > 1_000 {
            return invalid("Schema pattern must be at most 1000 characters.");
        }
        Ok(self)
    }

    /// The schema scope these settings select.
    pub fn schema_scope(&self) -> quarry_db_core::SchemaScope {
        quarry_db_core::SchemaScope {
            names: self.schema_names.clone(),
            patterns: self
                .schema_pattern
                .split(',')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(str::to_owned)
                .collect(),
        }
    }
}

const COLUMNS: &str = "id, name, engine, host, port, database, username, ssl_mode, \
    connect_timeout_secs, read_only, environment, color, save_mode, password_saved, created_at, updated_at, \
    tx_mode, isolation, history_enabled, folder_id, ssh_profile_id, tls_ca_file, tls_cert_file, \
    tls_key_file, keepalive_secs, auto_disconnect_mins, startup_sql, schema_names, schema_pattern, \
    url_only, sort_order";

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
                folder_id: row.get(19)?,
                ssh_profile_id: row.get(20)?,
                tls_ca_file: row.get(21)?,
                tls_cert_file: row.get(22)?,
                tls_key_file: row.get(23)?,
                keepalive_secs: row.get(24)?,
                auto_disconnect_mins: row.get(25)?,
                startup_sql: text(26)?,
                schema_names: serde_json::from_str(&text(27)?)?,
                schema_pattern: text(28)?,
                url_only: row.get(29)?,
            },
            password_saved: row.get(13)?,
            sort_order: row.get(30)?,
            created_at: text(14)?,
            updated_at: text(15)?,
        })
    })();
    Ok(parsed)
}

fn map_folder_unique(err: rusqlite::Error, name: &str) -> StoreError {
    match &err {
        rusqlite::Error::SqliteFailure(e, _) if e.code == ErrorCode::ConstraintViolation => {
            StoreError::Invalid(format!("A folder named \"{name}\" already exists."))
        }
        _ => StoreError::Sqlite(err),
    }
}

fn map_unique(err: rusqlite::Error, name: &str) -> StoreError {
    match &err {
        rusqlite::Error::SqliteFailure(e, _)
            if e.code == ErrorCode::ConstraintViolation
                && e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
        {
            StoreError::Invalid(format!("A data source named \"{name}\" already exists."))
        }
        rusqlite::Error::SqliteFailure(e, _)
            if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY =>
        {
            StoreError::Invalid("The folder or SSH profile no longer exists.".into())
        }
        _ => StoreError::Sqlite(err),
    }
}

/// The values bound as ?2..?27 by insert and update, in column order.
macro_rules! draft_params {
    ($id:expr, $d:expr, $names:expr) => {
        params![
            $id,
            $d.name,
            $d.engine.as_str(),
            $d.host,
            $d.port,
            $d.database,
            $d.username,
            $d.ssl_mode.as_str(),
            $d.connect_timeout_secs,
            $d.read_only,
            $d.environment.as_str(),
            $d.color,
            $d.save_mode.as_str(),
            tx_mode_text($d.tx_mode),
            isolation_text($d.isolation),
            $d.history_enabled,
            $d.folder_id,
            $d.ssh_profile_id,
            $d.tls_ca_file,
            $d.tls_cert_file,
            $d.tls_key_file,
            $d.keepalive_secs,
            $d.auto_disconnect_mins,
            $d.startup_sql,
            $names,
            $d.schema_pattern,
            $d.url_only
        ]
    };
}

impl Store {
    pub fn list_connections(&self) -> Result<Vec<ConnectionProfile>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM connections
             ORDER BY folder_id IS NOT NULL, folder_id, sort_order, name COLLATE NOCASE"
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
        let names = serde_json::to_string(&d.schema_names)?;
        // New data sources go last in their folder.
        self.conn()
            .execute(
                "INSERT INTO connections (id, name, engine, host, port, database, username, ssl_mode,
                     connect_timeout_secs, read_only, environment, color, save_mode, tx_mode, isolation,
                     history_enabled, folder_id, ssh_profile_id, tls_ca_file, tls_cert_file,
                     tls_key_file, keepalive_secs, auto_disconnect_mins, startup_sql, schema_names,
                     schema_pattern, url_only, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                     ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27,
                     (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM connections
                      WHERE folder_id IS ?17))",
                draft_params!(id, d, names),
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
        let names = serde_json::to_string(&d.schema_names)?;
        let changed = self
            .conn()
            .execute(
                "UPDATE connections SET name = ?2, engine = ?3, host = ?4, port = ?5, database = ?6,
                     username = ?7, ssl_mode = ?8, connect_timeout_secs = ?9, read_only = ?10,
                     environment = ?11, color = ?12, save_mode = ?13, tx_mode = ?14, isolation = ?15,
                     history_enabled = ?16, folder_id = ?17, ssh_profile_id = ?18,
                     tls_ca_file = ?19, tls_cert_file = ?20, tls_key_file = ?21,
                     keepalive_secs = ?22, auto_disconnect_mins = ?23, startup_sql = ?24,
                     schema_names = ?25, schema_pattern = ?26, url_only = ?27,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1",
                draft_params!(id, d, names),
            )
            .map_err(|e| map_unique(e, &d.name))?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!("data source {id}")));
        }
        self.require_connection(id)
    }

    /// Renames a data source (inline rename in the explorer).
    pub fn rename_connection(&self, id: &str, name: &str) -> Result<ConnectionProfile, StoreError> {
        let name = normalize_name(name, "Name")?;
        let changed = self
            .conn()
            .execute(
                "UPDATE connections SET name = ?2,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1",
                params![id, name],
            )
            .map_err(|e| map_unique(e, &name))?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!("data source {id}")));
        }
        self.require_connection(id)
    }

    /// Moves a data source into `folder_id` (`None` = top level) at position `index` among that
    /// folder's data sources, renumbering the folder so the order is dense.
    pub fn move_connection(
        &self,
        id: &str,
        folder_id: Option<&str>,
        index: usize,
    ) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let exists: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM connections WHERE id = ?1)",
            [id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(StoreError::NotFound(format!("data source {id}")));
        }
        if let Some(f) = folder_id {
            let folder: bool = tx.query_row(
                "SELECT EXISTS (SELECT 1 FROM folders WHERE id = ?1)",
                [f],
                |r| r.get(0),
            )?;
            if !folder {
                return Err(StoreError::NotFound(format!("folder {f}")));
            }
        }
        let mut siblings: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM connections WHERE folder_id IS ?1 AND id <> ?2
                 ORDER BY sort_order, name COLLATE NOCASE",
            )?;
            stmt.query_map(params![folder_id, id], |r| r.get(0))?
                .collect::<Result<_, _>>()?
        };
        siblings.insert(index.min(siblings.len()), id.to_owned());
        for (position, sibling) in siblings.iter().enumerate() {
            tx.execute(
                "UPDATE connections SET folder_id = ?2, sort_order = ?3 WHERE id = ?1",
                params![sibling, folder_id, position as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_folders(&self) -> Result<Vec<Folder>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, color, sort_order FROM folders ORDER BY sort_order, name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                sort_order: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    pub fn insert_folder(
        &self,
        id: &str,
        name: &str,
        color: Option<String>,
    ) -> Result<Folder, StoreError> {
        let name = normalize_name(name, "Folder name")?;
        let color = normalize_color(color)?;
        self.conn()
            .execute(
                "INSERT INTO folders (id, name, color, sort_order)
                 VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM folders))",
                params![id, name, color],
            )
            .map_err(|e| map_folder_unique(e, &name))?;
        self.require_folder(id)
    }

    pub fn update_folder(
        &self,
        id: &str,
        name: &str,
        color: Option<String>,
    ) -> Result<Folder, StoreError> {
        let name = normalize_name(name, "Folder name")?;
        let color = normalize_color(color)?;
        let changed = self
            .conn()
            .execute(
                "UPDATE folders SET name = ?2, color = ?3 WHERE id = ?1",
                params![id, name, color],
            )
            .map_err(|e| map_folder_unique(e, &name))?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!("folder {id}")));
        }
        self.require_folder(id)
    }

    /// Deletes a folder; its data sources move to the top level, after the ones already there.
    pub fn delete_folder(&self, id: &str) -> Result<bool, StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE connections SET folder_id = NULL,
                 sort_order = sort_order + (SELECT COALESCE(MAX(sort_order), -1) + 1
                                            FROM connections WHERE folder_id IS NULL)
             WHERE folder_id = ?1",
            [id],
        )?;
        let deleted = tx.execute("DELETE FROM folders WHERE id = ?1", [id])? > 0;
        tx.commit()?;
        Ok(deleted)
    }

    fn require_folder(&self, id: &str) -> Result<Folder, StoreError> {
        self.list_folders()?
            .into_iter()
            .find(|f| f.id == id)
            .ok_or_else(|| StoreError::NotFound(format!("folder {id}")))
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
            folder_id: None,
            ssh_profile_id: None,
            tls_ca_file: None,
            tls_cert_file: None,
            tls_key_file: None,
            keepalive_secs: 0,
            auto_disconnect_mins: 0,
            startup_sql: String::new(),
            schema_names: Vec::new(),
            schema_pattern: String::new(),
            url_only: false,
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

    fn order(store: &Store) -> Vec<(Option<String>, String)> {
        store
            .list_connections()
            .expect("list")
            .into_iter()
            .map(|c| (c.draft.folder_id, c.draft.name))
            .collect()
    }

    #[test]
    fn folders_hold_ordered_data_sources() {
        let store = Store::open_in_memory().expect("open");
        for (id, name) in [("a", "A"), ("b", "B"), ("c", "C")] {
            store.insert_connection(id, draft(name)).expect("insert");
        }
        let f = store
            .insert_folder("f", " Prod ", Some("#AA0000".into()))
            .expect("folder");
        assert_eq!(
            (f.name.as_str(), f.color.as_deref()),
            ("Prod", Some("#aa0000"))
        );
        let dup = store.insert_folder("g", "prod", None).expect_err("dup");
        assert!(dup.to_string().contains("already exists"), "{dup}");

        // Reorder at the top level, then move two sources into the folder.
        store.move_connection("c", None, 0).expect("move c first");
        assert_eq!(
            order(&store),
            [(None, "C".into()), (None, "A".into()), (None, "B".into())]
        );
        store
            .move_connection("a", Some("f"), 0)
            .expect("into folder");
        store
            .move_connection("b", Some("f"), 0)
            .expect("into folder first");
        let f_id = Some("f".to_owned());
        assert_eq!(
            order(&store),
            [
                (None, "C".into()),
                (f_id.clone(), "B".into()),
                (f_id, "A".into())
            ]
        );
        assert!(store.move_connection("a", Some("nope"), 0).is_err());

        // Deleting the folder keeps its sources, after the top-level ones.
        assert!(store.delete_folder("f").expect("delete"));
        assert_eq!(
            order(&store),
            [(None, "C".into()), (None, "B".into()), (None, "A".into())]
        );
    }

    #[test]
    fn rename_checks_uniqueness() {
        let store = Store::open_in_memory().expect("open");
        store.insert_connection("a", draft("A")).expect("insert");
        store.insert_connection("b", draft("B")).expect("insert");
        assert_eq!(
            store
                .rename_connection("a", " Alpha ")
                .expect("rename")
                .draft
                .name,
            "Alpha"
        );
        assert!(store.rename_connection("a", "b").is_err());
        assert!(store.rename_connection("a", "  ").is_err());
    }

    #[test]
    fn options_round_trip_and_validate() {
        let store = Store::open_in_memory().expect("open");
        let full = ConnectionDraft {
            tls_ca_file: Some("/etc/ssl/ca.pem".into()),
            tls_cert_file: Some("/etc/ssl/me.pem".into()),
            tls_key_file: Some("/etc/ssl/me.key".into()),
            keepalive_secs: 30,
            auto_disconnect_mins: 15,
            startup_sql: "SET search_path = app".into(),
            schema_names: vec!["shop".into(), " public ".into(), "shop".into()],
            schema_pattern: " app_* ".into(),
            url_only: true,
            ..draft("Full")
        };
        let p = store.insert_connection("a", full).expect("insert");
        assert_eq!(p.draft.schema_names, ["public", "shop"]);
        assert_eq!(p.draft.schema_pattern, "app_*");
        assert_eq!(p.draft.keepalive_secs, 30);
        assert!(p.draft.url_only);
        let scope = p.draft.schema_scope();
        assert!(scope.contains("app_x") && scope.contains("shop") && !scope.contains("x"));

        type Mutation = (&'static str, fn(&mut ConnectionDraft));
        let cases: [Mutation; 5] = [
            ("go together", |d| d.tls_key_file = None),
            ("absolute", |d| d.tls_ca_file = Some("ca.pem".into())),
            ("Keep-alive", |d| d.keepalive_secs = 3_601),
            ("Auto-disconnect", |d| d.auto_disconnect_mins = 1_441),
            ("Startup SQL", |d| {
                d.startup_sql = "x".repeat(STARTUP_SQL_MAX + 1)
            }),
        ];
        for (expected, mutate) in cases {
            let mut d = p.draft.clone();
            mutate(&mut d);
            let err = d.normalized().expect_err(expected);
            assert!(err.to_string().contains(expected), "{expected}: {err}");
        }
    }

    #[test]
    fn upgrading_from_version_4_keeps_profiles_with_new_defaults() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("app.db");
        {
            let mut raw = rusqlite::Connection::open(&path).expect("raw");
            crate::migrations::migrate_to(&mut raw, 4).expect("v4");
            raw.execute_batch(
                "INSERT INTO connections (id, name, engine, host, port, database, username,
                     ssl_mode, connect_timeout_secs, read_only, environment, color, save_mode)
                 VALUES ('old', 'Old', 'postgresql', 'h', 5432, 'd', 'u', 'prefer', 10, 0,
                     'none', NULL, 'never')",
            )
            .expect("v4 row");
        }
        let store = Store::open(&path).expect("upgrade");
        let p = store.get_connection("old").expect("get").expect("kept");
        assert_eq!(p.draft.folder_id, None);
        assert_eq!(p.draft.ssh_profile_id, None);
        assert!(p.draft.schema_names.is_empty() && p.draft.startup_sql.is_empty());
        assert_eq!(
            (p.draft.keepalive_secs, p.draft.auto_disconnect_mins),
            (0, 0)
        );
    }
}
