//! SSH profiles (reusable tunnel settings) and the host keys the user trusted. Passwords and key
//! passphrases live in `quarry-secrets`; only a `secret_saved` flag is recorded here (ADR-0003).

use rusqlite::{ErrorCode, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::connections::normalize_name;
use crate::{SaveMode, Store, StoreError};

/// How the tunnel logs in to the SSH server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SshAuthMethod {
    Password,
    /// A private key file, with a passphrase if it is encrypted.
    Key,
    /// Keys held by the running SSH agent.
    Agent,
}

impl SshAuthMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Password => "password",
            Self::Key => "key",
            Self::Agent => "agent",
        }
    }

    fn parse(s: &str) -> Result<Self, StoreError> {
        match s {
            "password" => Ok(Self::Password),
            "key" => Ok(Self::Key),
            "agent" => Ok(Self::Agent),
            other => Err(StoreError::Invalid(format!(
                "unknown SshAuthMethod '{other}'"
            ))),
        }
    }
}

/// Editable fields of an SSH profile, as sent by the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshProfileDraft {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuthMethod,
    /// Private key file (absolute path) for `Key` auth.
    pub key_file: Option<String>,
    /// Where the password (`Password` auth) or key passphrase (`Key` auth) is kept.
    pub save_mode: SaveMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SshProfile {
    pub id: String,
    #[serde(flatten)]
    pub draft: SshProfileDraft,
    /// True when the password or passphrase is stored (for this run, with `untilRestart`).
    pub secret_saved: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl SshProfileDraft {
    pub fn normalized(mut self) -> Result<Self, StoreError> {
        let invalid = |msg: &str| Err(StoreError::Invalid(msg.to_owned()));
        self.name = normalize_name(&self.name, "SSH profile name")?;
        self.host = self.host.trim().to_owned();
        self.username = self.username.trim().to_owned();
        self.key_file = self
            .key_file
            .map(|k| k.trim().to_owned())
            .filter(|k| !k.is_empty());
        if self.host.is_empty()
            || self.host.len() > 255
            || self.host.chars().any(char::is_whitespace)
        {
            return invalid("SSH host must be a hostname or IP address without spaces.");
        }
        if self.port == 0 {
            return invalid("SSH port must be between 1 and 65535.");
        }
        if self.username.is_empty() || self.username.len() > 128 {
            return invalid("SSH user is required (at most 128 characters).");
        }
        match (&self.auth, &self.key_file) {
            (SshAuthMethod::Key, None) => return invalid("Choose a private key file."),
            (SshAuthMethod::Key, Some(k))
                if k.len() > crate::connections::PATH_MAX
                    || !std::path::Path::new(k).is_absolute() =>
            {
                return invalid("The private key file must be an absolute path.");
            }
            (SshAuthMethod::Key, Some(_)) => {}
            // A key file only matters for key authentication.
            _ => self.key_file = None,
        }
        Ok(self)
    }
}

const COLUMNS: &str = "id, name, host, port, username, auth, key_file, save_mode, secret_saved, created_at, updated_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Result<SshProfile, StoreError>> {
    let text = |i: usize| row.get::<_, String>(i);
    let parsed = (|| -> Result<SshProfile, StoreError> {
        Ok(SshProfile {
            id: text(0)?,
            draft: SshProfileDraft {
                name: text(1)?,
                host: text(2)?,
                port: row.get(3)?,
                username: text(4)?,
                auth: SshAuthMethod::parse(&text(5)?)?,
                key_file: row.get(6)?,
                save_mode: SaveMode::parse(&text(7)?)?,
            },
            secret_saved: row.get(8)?,
            created_at: text(9)?,
            updated_at: text(10)?,
        })
    })();
    Ok(parsed)
}

fn map_unique(err: rusqlite::Error, name: &str) -> StoreError {
    match &err {
        rusqlite::Error::SqliteFailure(e, _) if e.code == ErrorCode::ConstraintViolation => {
            StoreError::Invalid(format!("An SSH profile named \"{name}\" already exists."))
        }
        _ => StoreError::Sqlite(err),
    }
}

/// A host key the user trusted for an SSH endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedHostKey {
    pub algorithm: String,
    pub fingerprint: String,
}

impl Store {
    pub fn list_ssh_profiles(&self) -> Result<Vec<SshProfile>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM ssh_profiles ORDER BY name COLLATE NOCASE"
        ))?;
        let rows = stmt.query_map([], from_row)?;
        rows.map(|r| r?).collect()
    }

    pub fn get_ssh_profile(&self, id: &str) -> Result<Option<SshProfile>, StoreError> {
        self.conn()
            .query_row(
                &format!("SELECT {COLUMNS} FROM ssh_profiles WHERE id = ?1"),
                [id],
                from_row,
            )
            .optional()?
            .transpose()
    }

    pub fn insert_ssh_profile(
        &self,
        id: &str,
        draft: SshProfileDraft,
    ) -> Result<SshProfile, StoreError> {
        let d = draft.normalized()?;
        self.conn()
            .execute(
                "INSERT INTO ssh_profiles (id, name, host, port, username, auth, key_file, save_mode)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id,
                    d.name,
                    d.host,
                    d.port,
                    d.username,
                    d.auth.as_str(),
                    d.key_file,
                    d.save_mode.as_str()
                ],
            )
            .map_err(|e| map_unique(e, &d.name))?;
        self.require_ssh_profile(id)
    }

    pub fn update_ssh_profile(
        &self,
        id: &str,
        draft: SshProfileDraft,
    ) -> Result<SshProfile, StoreError> {
        let d = draft.normalized()?;
        let changed = self
            .conn()
            .execute(
                "UPDATE ssh_profiles SET name = ?2, host = ?3, port = ?4, username = ?5, auth = ?6,
                     key_file = ?7, save_mode = ?8,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1",
                params![
                    id,
                    d.name,
                    d.host,
                    d.port,
                    d.username,
                    d.auth.as_str(),
                    d.key_file,
                    d.save_mode.as_str()
                ],
            )
            .map_err(|e| map_unique(e, &d.name))?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!("SSH profile {id}")));
        }
        self.require_ssh_profile(id)
    }

    /// Names of the data sources that tunnel through profile `id`.
    pub fn ssh_profile_users(&self, id: &str) -> Result<Vec<String>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT name FROM connections WHERE ssh_profile_id = ?1 ORDER BY name COLLATE NOCASE",
        )?;
        Ok(stmt
            .query_map([id], |r| r.get(0))?
            .collect::<Result<_, _>>()?)
    }

    /// Deletes a profile no data source uses. A profile in use is refused, so a data source
    /// never silently switches from a tunnel to a direct connection.
    pub fn delete_ssh_profile(&self, id: &str) -> Result<bool, StoreError> {
        let users = self.ssh_profile_users(id)?;
        if !users.is_empty() {
            return Err(StoreError::Invalid(format!(
                "This SSH profile is used by {}. Choose another tunnel for them first.",
                users.join(", ")
            )));
        }
        Ok(self
            .conn()
            .execute("DELETE FROM ssh_profiles WHERE id = ?1", [id])?
            > 0)
    }

    pub fn set_ssh_secret_saved(&self, id: &str, saved: bool) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE ssh_profiles SET secret_saved = ?2 WHERE id = ?1",
            params![id, saved],
        )?;
        Ok(())
    }

    fn require_ssh_profile(&self, id: &str) -> Result<SshProfile, StoreError> {
        self.get_ssh_profile(id)?
            .ok_or_else(|| StoreError::NotFound(format!("SSH profile {id}")))
    }

    pub fn trusted_host_key(
        &self,
        host: &str,
        port: u16,
    ) -> Result<Option<TrustedHostKey>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT algorithm, fingerprint FROM ssh_known_hosts WHERE host = ?1 AND port = ?2",
                params![host.to_ascii_lowercase(), port],
                |r| {
                    Ok(TrustedHostKey {
                        algorithm: r.get(0)?,
                        fingerprint: r.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    /// Records (or replaces) the trusted host key of an SSH endpoint.
    pub fn trust_host_key(
        &self,
        host: &str,
        port: u16,
        key: &TrustedHostKey,
    ) -> Result<(), StoreError> {
        self.conn().execute(
            "INSERT INTO ssh_known_hosts (host, port, algorithm, fingerprint) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (host, port) DO UPDATE SET algorithm = excluded.algorithm,
                 fingerprint = excluded.fingerprint,
                 trusted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
            params![
                host.to_ascii_lowercase(),
                port,
                key.algorithm,
                key.fingerprint
            ],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn draft(name: &str) -> SshProfileDraft {
        SshProfileDraft {
            name: name.into(),
            host: "bastion.example.test".into(),
            port: 22,
            username: "deploy".into(),
            auth: SshAuthMethod::Agent,
            key_file: Some("/tmp/ignored".into()),
            save_mode: SaveMode::Forever,
        }
    }

    #[test]
    fn profiles_round_trip_and_drop_unused_key_files() {
        let store = Store::open_in_memory().expect("open");
        let p = store
            .insert_ssh_profile("s1", draft(" Bastion "))
            .expect("insert");
        assert_eq!(p.draft.name, "Bastion");
        assert_eq!(p.draft.key_file, None, "agent auth keeps no key file");
        let next = SshProfileDraft {
            auth: SshAuthMethod::Key,
            key_file: Some("/home/me/.ssh/id_ed25519".into()),
            ..draft("Bastion")
        };
        let updated = store.update_ssh_profile("s1", next).expect("update");
        assert_eq!(
            updated.draft.key_file.as_deref(),
            Some("/home/me/.ssh/id_ed25519")
        );
        assert_eq!(store.list_ssh_profiles().expect("list").len(), 1);
        let err = store
            .insert_ssh_profile("s2", draft("bastion"))
            .expect_err("dup");
        assert!(err.to_string().contains("already exists"), "{err}");
    }

    #[test]
    fn key_auth_needs_an_absolute_key_file() {
        let mut d = draft("x");
        d.auth = SshAuthMethod::Key;
        d.key_file = None;
        assert!(d.clone().normalized().is_err());
        d.key_file = Some("id_rsa".into());
        assert!(d.normalized().is_err());
    }

    #[test]
    fn profiles_in_use_cannot_be_deleted() {
        let store = Store::open_in_memory().expect("open");
        store.insert_ssh_profile("s1", draft("B")).expect("insert");
        let mut conn = crate::connections::tests::draft("Prod");
        conn.ssh_profile_id = Some("s1".into());
        store.insert_connection("c1", conn).expect("insert conn");
        let err = store.delete_ssh_profile("s1").expect_err("in use");
        assert!(err.to_string().contains("Prod"), "{err}");
        store.delete_connection("c1").expect("delete conn");
        assert!(store.delete_ssh_profile("s1").expect("delete"));
    }

    #[test]
    fn host_keys_are_trusted_per_endpoint() {
        let store = Store::open_in_memory().expect("open");
        assert_eq!(store.trusted_host_key("h", 22).expect("get"), None);
        let key = TrustedHostKey {
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:abc".into(),
        };
        store.trust_host_key("H", 22, &key).expect("trust");
        assert_eq!(store.trusted_host_key("h", 22).expect("get"), Some(key));
        assert_eq!(store.trusted_host_key("h", 2222).expect("get"), None);
    }
}
