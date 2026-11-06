//! Connection manager (module A). Owns the invariants between profiles (app.db) and their secrets:
//! a profile's password lives in exactly the place its `save_mode` says, and nowhere else.

use std::sync::Arc;

use std::time::Duration;

use quarry_db_core::{ConnectOptions, ConnectParams, TlsFiles, TlsMode};
use quarry_secrets::{CredentialStore, MemoryStore, SecretError, SecretString};
use quarry_store::{
    ConnectionDraft, ConnectionProfile, Folder, SaveMode, SshAuthMethod, SshProfile,
    SshProfileDraft, SslMode, Store, StoreError,
};
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
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(tag = "action", content = "value", rename_all = "camelCase")]
pub enum PasswordChange {
    #[default]
    Keep,
    Set(#[cfg_attr(feature = "ts", ts(type = "string"))] SecretString),
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

/// Keyring account of an SSH profile's secret: its password, or its key's passphrase (ADR-0003).
fn ssh_account(id: &str, auth: SshAuthMethod) -> Option<String> {
    match auth {
        SshAuthMethod::Password => Some(format!("ssh:{id}:password")),
        SshAuthMethod::Key => Some(format!("ssh:{id}:passphrase")),
        SshAuthMethod::Agent => None,
    }
}

/// Every account a profile may have used, for clean-up when its auth method changes.
fn ssh_accounts(id: &str) -> [String; 2] {
    [format!("ssh:{id}:password"), format!("ssh:{id}:passphrase")]
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
            tracing::warn!(id = %id, error = %e, "data source not created: credential store refused");
            return Err(e);
        }
        tracing::info!(
            id = %profile.id,
            name = %profile.draft.name,
            host = %profile.draft.host,
            save_mode = mode.as_str(),
            "data source created"
        );
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
        tracing::info!(id = %id, save_mode = new_mode.as_str(), "data source updated");

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
        tracing::info!(id = %id, "data source deleted");
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

    // ---- Folders and order ----

    pub fn folders(&self) -> Result<Vec<Folder>, ConnectionError> {
        Ok(self.store.list_folders()?)
    }

    pub fn create_folder(
        &self,
        name: &str,
        color: Option<String>,
    ) -> Result<Folder, ConnectionError> {
        let id = uuid::Uuid::new_v4().to_string();
        Ok(self.store.insert_folder(&id, name, color)?)
    }

    pub fn update_folder(
        &self,
        id: &str,
        name: &str,
        color: Option<String>,
    ) -> Result<Folder, ConnectionError> {
        Ok(self.store.update_folder(id, name, color)?)
    }

    pub fn delete_folder(&self, id: &str) -> Result<(), ConnectionError> {
        if !self.store.delete_folder(id)? {
            return Err(ConnectionError::NotFound);
        }
        Ok(())
    }

    pub fn rename(&self, id: &str, name: &str) -> Result<ConnectionProfile, ConnectionError> {
        self.store.rename_connection(id, name)?;
        self.reload(id)
    }

    pub fn move_to(
        &self,
        id: &str,
        folder_id: Option<&str>,
        index: usize,
    ) -> Result<(), ConnectionError> {
        Ok(self.store.move_connection(id, folder_id, index)?)
    }

    // ---- SSH profiles: the secret lives where the profile's save mode says, like passwords ----

    pub fn ssh_profiles(&self) -> Result<Vec<SshProfile>, ConnectionError> {
        self.store
            .list_ssh_profiles()?
            .into_iter()
            .map(|p| self.with_ssh_session_flag(p))
            .collect()
    }

    pub fn create_ssh_profile(
        &self,
        draft: SshProfileDraft,
        secret: Option<SecretString>,
    ) -> Result<SshProfile, ConnectionError> {
        let id = uuid::Uuid::new_v4().to_string();
        let profile = self.store.insert_ssh_profile(&id, draft)?;
        if let Some(secret) = secret.filter(|_| profile.draft.save_mode != SaveMode::Never)
            && let Err(e) = self.put_ssh_secret(&profile, &secret)
        {
            let _ = self.store.delete_ssh_profile(&id);
            return Err(e);
        }
        tracing::info!(id = %id, host = %profile.draft.host, auth = profile.draft.auth.as_str(), "ssh profile created");
        self.reload_ssh(&id)
    }

    pub fn update_ssh_profile(
        &self,
        id: &str,
        draft: SshProfileDraft,
        change: PasswordChange,
    ) -> Result<SshProfile, ConnectionError> {
        let current = self
            .store
            .get_ssh_profile(id)?
            .ok_or(ConnectionError::NotFound)?;
        let updated = self.store.update_ssh_profile(id, draft)?;
        let keep_old = current.draft.auth == updated.draft.auth
            && current.draft.key_file == updated.draft.key_file;
        let secret = match change {
            PasswordChange::Set(s) => Some(s),
            PasswordChange::Clear => None,
            // A different method or key needs a different secret.
            PasswordChange::Keep if !keep_old => None,
            PasswordChange::Keep if current.draft.save_mode == updated.draft.save_mode => {
                return self.reload_ssh(id);
            }
            PasswordChange::Keep => self.get_ssh_secret(&current)?,
        };
        self.clear_ssh_secret(id)?;
        if let Some(s) = secret.filter(|_| updated.draft.save_mode != SaveMode::Never) {
            self.put_ssh_secret(&updated, &s)?;
        }
        self.reload_ssh(id)
    }

    pub fn delete_ssh_profile(&self, id: &str) -> Result<(), ConnectionError> {
        if !self.store.ssh_profile_users(id)?.is_empty() {
            // Let the store word the refusal.
            self.store.delete_ssh_profile(id)?;
        }
        self.clear_ssh_secret(id)?;
        if !self.store.delete_ssh_profile(id)? {
            return Err(ConnectionError::NotFound);
        }
        Ok(())
    }

    pub fn ssh_profile(&self, id: &str) -> Result<SshProfile, ConnectionError> {
        self.reload_ssh(id)
    }

    /// The SSH secret for a connect: an explicit one (typed or prompted) wins over the stored one.
    pub fn ssh_secret(
        &self,
        profile: &SshProfile,
        explicit: Option<SecretString>,
    ) -> Result<Option<SecretString>, ConnectionError> {
        match explicit {
            Some(s) => Ok(Some(s)),
            None => self.get_ssh_secret(profile),
        }
    }

    fn put_ssh_secret(&self, p: &SshProfile, s: &SecretString) -> Result<(), ConnectionError> {
        let Some(account) = ssh_account(&p.id, p.draft.auth) else {
            return Ok(());
        };
        match p.draft.save_mode {
            SaveMode::Forever => {
                self.persistent.set(&account, s)?;
                self.store.set_ssh_secret_saved(&p.id, true)?;
            }
            SaveMode::UntilRestart => self.session.set(&account, s)?,
            SaveMode::Never => {}
        }
        Ok(())
    }

    fn get_ssh_secret(&self, p: &SshProfile) -> Result<Option<SecretString>, ConnectionError> {
        let Some(account) = ssh_account(&p.id, p.draft.auth) else {
            return Ok(None);
        };
        Ok(match p.draft.save_mode {
            SaveMode::Forever => self.persistent.get(&account)?,
            SaveMode::UntilRestart => self.session.get(&account)?,
            SaveMode::Never => None,
        })
    }

    fn clear_ssh_secret(&self, id: &str) -> Result<(), ConnectionError> {
        for account in ssh_accounts(id) {
            self.session.delete(&account)?;
            self.persistent.delete(&account)?;
        }
        self.store.set_ssh_secret_saved(id, false)?;
        Ok(())
    }

    fn reload_ssh(&self, id: &str) -> Result<SshProfile, ConnectionError> {
        let p = self
            .store
            .get_ssh_profile(id)?
            .ok_or(ConnectionError::NotFound)?;
        self.with_ssh_session_flag(p)
    }

    fn with_ssh_session_flag(&self, mut p: SshProfile) -> Result<SshProfile, ConnectionError> {
        if p.draft.save_mode == SaveMode::UntilRestart {
            p.secret_saved = match ssh_account(&p.id, p.draft.auth) {
                Some(account) => self.session.get(&account)?.is_some(),
                None => false,
            };
        }
        Ok(p)
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
    let schema_scope = d.schema_scope();
    let params = ConnectParams {
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
        options: ConnectOptions {
            tls_files: TlsFiles {
                ca: d.tls_ca_file.as_ref().map(Into::into),
                cert: d.tls_cert_file.as_ref().map(Into::into),
                key: d.tls_key_file.as_ref().map(Into::into),
            },
            keepalive: (d.keepalive_secs > 0)
                .then(|| Duration::from_secs(u64::from(d.keepalive_secs))),
            schema_scope,
            startup_sql: d.startup_sql,
            // The tunnel (if any) is opened by the caller, which sets `dial` and `guard`.
            dial: None,
            guard: None,
        },
    };
    // `ConnectParams`'s Debug never prints the password; the log writer redacts as a second line.
    tracing::debug!(?params, "connect parameters");
    Ok(params)
}

#[cfg(test)]
mod tests;
