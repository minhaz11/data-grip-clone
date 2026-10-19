//! Connection manager (module A). Owns the invariants between profiles (app.db) and their secrets:
//! a profile's password lives in exactly the place its `save_mode` says, and nowhere else.

use std::sync::Arc;

use std::time::Duration;

use quarry_db_core::{ConnectParams, TlsMode};
use quarry_secrets::{CredentialStore, MemoryStore, SecretError, SecretString};
use quarry_store::{ConnectionDraft, ConnectionProfile, SaveMode, SslMode, Store, StoreError};
use serde::Deserialize;

#[derive(Debug, thiserror::Error)]
pub enum ConnectionError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Secret(#[from] SecretError),
    #[error("{0}")]
    Invalid(String),
    #[error("data source not found")]
    NotFound,
}

/// What to do with the password on update. Absent means `Keep`.
#[derive(Debug, Default, Deserialize)]
#[serde(tag = "action", content = "value", rename_all = "camelCase")]
pub enum PasswordChange {
    #[default]
    Keep,
    Set(SecretString),
    Clear,
}

pub struct ConnectionManager {
    store: Arc<Store>,
    /// Save mode `forever`: the OS credential store.
    persistent: Arc<dyn CredentialStore>,
    /// Save mode `untilRestart`: process memory.
    session: MemoryStore,
}

fn account(id: &str) -> String {
    format!("conn:{id}:password")
}

impl ConnectionManager {
    pub fn new(store: Arc<Store>, persistent: Arc<dyn CredentialStore>) -> Self {
        Self {
            store,
            persistent,
            session: MemoryStore::default(),
        }
    }

    /// Profiles with `password_saved` reflecting where the secret actually is for this run.
    pub fn list(&self) -> Result<Vec<ConnectionProfile>, ConnectionError> {
        self.store
            .list_connections()?
            .into_iter()
            .map(|p| self.with_session_flag(p))
            .collect()
    }

    pub fn create(
        &self,
        draft: ConnectionDraft,
        password: Option<SecretString>,
    ) -> Result<ConnectionProfile, ConnectionError> {
        if draft.save_mode == SaveMode::Never && password.is_some() {
            return Err(ConnectionError::Invalid(
                "A password cannot be saved when \"Save password\" is set to Never.".into(),
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mode = draft.save_mode;
        let profile = self.store.insert_connection(&id, draft)?;
        if let Some(secret) = password
            && let Err(e) = self.put_secret(&id, mode, &secret)
        {
            // Roll back so a failed keyring write never leaves a half-created data source.
            let _ = self.store.delete_connection(&id);
            return Err(e);
        }
        self.reload(&profile.id)
    }

    pub fn update(
        &self,
        id: &str,
        draft: ConnectionDraft,
        change: PasswordChange,
    ) -> Result<ConnectionProfile, ConnectionError> {
        let current = self
            .store
            .get_connection(id)?
            .ok_or(ConnectionError::NotFound)?;
        let (old_mode, new_mode) = (current.draft.save_mode, draft.save_mode);
        if new_mode == SaveMode::Never && matches!(change, PasswordChange::Set(_)) {
            return Err(ConnectionError::Invalid(
                "A password cannot be saved when \"Save password\" is set to Never.".into(),
            ));
        }
        // Validate and persist the profile first; secrets only move once that succeeded.
        self.store.update_connection(id, draft)?;

        let secret = match change {
            PasswordChange::Set(s) => Some(s),
            PasswordChange::Clear => None,
            PasswordChange::Keep if old_mode != new_mode => self.get_secret(id, old_mode)?,
            PasswordChange::Keep => return self.reload(id),
        };
        self.clear_secret(id)?;
        if let Some(s) = secret.filter(|_| new_mode != SaveMode::Never) {
            self.put_secret(id, new_mode, &s)?;
        }
        self.reload(id)
    }

    /// Copies every setting, including the saved password (same save mode), under a new name.
    pub fn duplicate(&self, id: &str) -> Result<ConnectionProfile, ConnectionError> {
        let source = self
            .store
            .get_connection(id)?
            .ok_or(ConnectionError::NotFound)?;
        let mut draft = source.draft.clone();
        draft.name = self.store.unique_copy_name(&source.draft.name)?;
        let secret = self.get_secret(id, source.draft.save_mode)?;
        self.create(draft, secret)
    }

    /// Removes the secret first: if the credential store refuses, nothing is deleted.
    pub fn delete(&self, id: &str) -> Result<(), ConnectionError> {
        self.store
            .get_connection(id)?
            .ok_or(ConnectionError::NotFound)?;
        self.clear_secret(id)?;
        self.store.delete_connection(id)?;
        Ok(())
    }

    /// The password to use when connecting; `None` means the UI must prompt (M2.2).
    pub fn password_for_connect(&self, id: &str) -> Result<Option<SecretString>, ConnectionError> {
        let p = self
            .store
            .get_connection(id)?
            .ok_or(ConnectionError::NotFound)?;
        self.get_secret(id, p.draft.save_mode)
    }

    /// Password for a connect/test attempt: an explicit one (typed or prompted) wins; otherwise the
    /// stored secret of `id`, if any. `None` lets the server decide (trust/peer auth, or prompt).
    pub fn resolve_password(
        &self,
        id: Option<&str>,
        explicit: Option<SecretString>,
    ) -> Result<Option<SecretString>, ConnectionError> {
        match (explicit, id) {
            (Some(p), _) => Ok(Some(p)),
            (None, Some(id)) => self.password_for_connect(id),
            (None, None) => Ok(None),
        }
    }

    pub fn profile(&self, id: &str) -> Result<ConnectionProfile, ConnectionError> {
        self.reload(id)
    }

    fn put_secret(
        &self,
        id: &str,
        mode: SaveMode,
        s: &SecretString,
    ) -> Result<(), ConnectionError> {
        match mode {
            SaveMode::Forever => {
                self.persistent.set(&account(id), s)?;
                self.store.set_password_saved(id, true)?;
            }
            SaveMode::UntilRestart => self.session.set(&account(id), s)?,
            SaveMode::Never => {}
        }
        Ok(())
    }

    fn get_secret(
        &self,
        id: &str,
        mode: SaveMode,
    ) -> Result<Option<SecretString>, ConnectionError> {
        Ok(match mode {
            SaveMode::Forever => self.persistent.get(&account(id))?,
            SaveMode::UntilRestart => self.session.get(&account(id))?,
            SaveMode::Never => None,
        })
    }

    fn clear_secret(&self, id: &str) -> Result<(), ConnectionError> {
        self.session.delete(&account(id))?;
        self.persistent.delete(&account(id))?;
        self.store.set_password_saved(id, false)?;
        Ok(())
    }

    fn reload(&self, id: &str) -> Result<ConnectionProfile, ConnectionError> {
        let p = self
            .store
            .get_connection(id)?
            .ok_or(ConnectionError::NotFound)?;
        self.with_session_flag(p)
    }

    fn with_session_flag(
        &self,
        mut p: ConnectionProfile,
    ) -> Result<ConnectionProfile, ConnectionError> {
        if p.draft.save_mode == SaveMode::UntilRestart {
            p.password_saved = self.session.get(&account(&p.id))?.is_some();
        }
        Ok(p)
    }
}

/// Driver parameters for a profile. Validates the draft so tests of unsaved drafts get the same
/// checks as saved profiles.
pub fn connect_params(
    draft: ConnectionDraft,
    password: Option<SecretString>,
) -> Result<ConnectParams, ConnectionError> {
    let d = draft.normalized()?;
    Ok(ConnectParams {
        host: d.host,
        port: d.port,
        database: d.database,
        username: d.username,
        password,
        tls: match d.ssl_mode {
            SslMode::Disable => TlsMode::Disable,
            SslMode::Prefer => TlsMode::Prefer,
            SslMode::Require => TlsMode::Require,
            SslMode::VerifyCa => TlsMode::VerifyCa,
            SslMode::VerifyFull => TlsMode::VerifyFull,
        },
        connect_timeout: Duration::from_secs(u64::from(d.connect_timeout_secs)),
        read_only: d.read_only,
        application_name: "Quarry".into(),
    })
}

#[cfg(test)]
mod tests;
