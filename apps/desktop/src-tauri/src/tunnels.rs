//! SSH tunnels for data sources that use an SSH profile. The tunnel is opened before the database
//! connection and handed to it as `ConnectOptions::guard`, so it lives exactly as long as the
//! sessions (and side connections) that use it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use quarry_connections::ConnectionManager;
use quarry_db_core::{ConnectErrorKind, ConnectParams};
use quarry_secrets::SecretString;
use quarry_ssh::{HostKey, KnownHosts, SshAuth, SshError, SshTarget, Tunnel};
use quarry_store::{ConnectionDraft, SshAuthMethod, SshProfileDraft, Store, TrustedHostKey};

use crate::error::{AppError, HostKeyPrompt};

/// Host keys trusted by the user, kept in app.db (not `~/.ssh/known_hosts`).
struct StoreKnownHosts(Arc<Store>);

impl KnownHosts for StoreKnownHosts {
    fn lookup(&self, host: &str, port: u16) -> Result<Option<HostKey>, String> {
        self.0
            .trusted_host_key(host, port)
            .map(|k| {
                k.map(|k| HostKey {
                    algorithm: k.algorithm,
                    fingerprint: k.fingerprint,
                })
            })
            .map_err(|e| e.to_string())
    }
}

/// Opens tunnels and remembers the host keys servers presented, so "Trust" can only confirm a
/// key this app actually saw (the WebView never supplies a fingerprint of its own).
pub struct Tunnels {
    store: Arc<Store>,
    presented: Mutex<HashMap<(String, u16), HostKey>>,
}

impl Tunnels {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            store,
            presented: Mutex::default(),
        }
    }

    /// If `draft` uses an SSH profile, opens its tunnel and points `params` at it. `unsaved` is
    /// an SSH profile being edited in the dialog (tested before it is saved); its secret is the
    /// typed one, else the stored one of the profile `draft` refers to.
    pub async fn attach(
        &self,
        manager: &Arc<ConnectionManager>,
        draft: &ConnectionDraft,
        unsaved: Option<SshProfileDraft>,
        ssh_secret: Option<SecretString>,
        params: &mut ConnectParams,
    ) -> Result<(), AppError> {
        if draft.ssh_profile_id.is_none() && unsaved.is_none() {
            return Ok(());
        }
        let manager = Arc::clone(manager);
        let profile_id = draft.ssh_profile_id.clone();
        let (d, secret) = tauri::async_runtime::spawn_blocking(move || {
            let saved = profile_id.map(|id| manager.ssh_profile(&id)).transpose()?;
            let d = match (unsaved, &saved) {
                (Some(u), _) => u
                    .normalized()
                    .map_err(quarry_connections::ConnectionError::from)?,
                (None, Some(p)) => p.draft.clone(),
                (None, None) => unreachable!("checked above"),
            };
            let secret = match (ssh_secret, &saved) {
                (Some(s), _) => Some(s),
                (None, Some(p)) if p.draft.auth == d.auth => manager.ssh_secret(p, None)?,
                (None, _) => None,
            };
            Ok::<_, quarry_connections::ConnectionError>((d, secret))
        })
        .await
        .map_err(|e| AppError::new("internal", format!("task failed: {e}")))??;

        let target = SshTarget {
            host: d.host.clone(),
            port: d.port,
            username: d.username.clone(),
            auth: match d.auth {
                SshAuthMethod::Password => SshAuth::Password(secret),
                SshAuthMethod::Key => SshAuth::Key {
                    path: d.key_file.clone().unwrap_or_default().into(),
                    passphrase: secret,
                },
                SshAuthMethod::Agent => SshAuth::Agent,
            },
            connect_timeout: params.connect_timeout.max(Duration::from_secs(5)),
        };
        let known = StoreKnownHosts(Arc::clone(&self.store));
        let tunnel = Tunnel::open(&target, &known, &params.host, params.port)
            .await
            .map_err(|e| self.error(&d.host, d.port, e))?;
        tracing::info!(ssh = %d.host, "connecting through ssh tunnel");
        params.options.dial = Some(tunnel.local_addr());
        params.options.guard = Some(Arc::new(tunnel));
        Ok(())
    }

    /// Trusts the key `host:port` presented on the last attempt, if it has `fingerprint`.
    pub fn trust(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), AppError> {
        let key = self
            .presented
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&(host.to_ascii_lowercase(), port))
            .cloned()
            .filter(|k| k.fingerprint == fingerprint)
            .ok_or_else(|| {
                AppError::new(
                    "invalid",
                    "This host key was not presented by the server. Connect again to see the current key.",
                )
            })?;
        self.store.trust_host_key(
            host,
            port,
            &TrustedHostKey {
                algorithm: key.algorithm,
                fingerprint: key.fingerprint,
            },
        )?;
        tracing::info!(host = %host, port, fingerprint = %fingerprint, "ssh host key trusted");
        Ok(())
    }

    fn error(&self, host: &str, port: u16, e: SshError) -> AppError {
        tracing::warn!(host = %host, port, error = %e, "ssh tunnel failed");
        let message = e.to_string();
        let (kind, hint, host_key) = match e {
            SshError::Dns { .. } => (
                ConnectErrorKind::Dns,
                "Check the SSH host name on the SSH tab, your network connection, or VPN.",
                None,
            ),
            SshError::Refused { .. } => (
                ConnectErrorKind::Refused,
                "Check the SSH host and port, and that the SSH server is running.",
                None,
            ),
            SshError::Timeout { .. } => (
                ConnectErrorKind::Timeout,
                "Check the SSH host and port, firewalls or VPN, or increase the connect timeout.",
                None,
            ),
            SshError::HostUnknown { presented } => {
                self.remember(host, port, &presented);
                (
                    ConnectErrorKind::SshHostUnknown,
                    "Compare the fingerprint with the one your server administrator gives you \
                     before trusting it.",
                    Some(Box::new(prompt(host, port, presented, None))),
                )
            }
            SshError::HostChanged {
                expected,
                presented,
            } => {
                self.remember(host, port, &presented);
                (
                    ConnectErrorKind::SshHostChanged,
                    "Someone may be intercepting the connection, or the server was reinstalled. \
                     Trust the new key only if your administrator confirms the change.",
                    Some(Box::new(prompt(
                        host,
                        port,
                        presented,
                        Some(expected.fingerprint),
                    ))),
                )
            }
            SshError::Auth(_) => (
                ConnectErrorKind::Auth,
                "Check the SSH user, password, key file and passphrase on the SSH tab.",
                None,
            ),
            SshError::SecretRequired(_) => (
                ConnectErrorKind::SshSecretRequired,
                "Enter it when asked, or save it in the SSH profile.",
                None,
            ),
            SshError::Key(_) => (
                ConnectErrorKind::Ssh,
                "Choose an OpenSSH or PEM private key file on the SSH tab.",
                None,
            ),
            SshError::Agent(_) => (
                ConnectErrorKind::Ssh,
                "Start your SSH agent and add the key (ssh-add), or use a key file.",
                None,
            ),
            SshError::Forward { .. } => (
                ConnectErrorKind::Ssh,
                "The database host and port are resolved by the SSH server: check them as seen \
                 from there, and that the server allows TCP forwarding.",
                None,
            ),
            SshError::Other(_) => (
                ConnectErrorKind::Ssh,
                "Check the SSH settings on the SSH tab.",
                None,
            ),
        };
        AppError {
            hint: Some(hint.into()),
            connect_kind: Some(kind),
            host_key,
            tunnel: Some(true),
            ..AppError::new("connect", message)
        }
    }

    fn remember(&self, host: &str, port: u16, key: &HostKey) {
        self.presented
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert((host.to_ascii_lowercase(), port), key.clone());
    }
}

fn prompt(host: &str, port: u16, key: HostKey, expected: Option<String>) -> HostKeyPrompt {
    HostKeyPrompt {
        host: host.to_owned(),
        port,
        algorithm: key.algorithm,
        fingerprint: key.fingerprint,
        expected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(fp: &str) -> HostKey {
        HostKey {
            algorithm: "ssh-ed25519".into(),
            fingerprint: fp.into(),
        }
    }

    #[test]
    fn only_a_presented_key_can_be_trusted() {
        let store = Arc::new(Store::open_in_memory().expect("store"));
        let tunnels = Tunnels::new(Arc::clone(&store));
        let err = tunnels
            .trust("bastion", 22, "SHA256:made-up")
            .expect_err("unseen");
        assert_eq!(err.kind, "invalid");

        let e = tunnels.error(
            "Bastion",
            22,
            SshError::HostUnknown {
                presented: key("SHA256:seen"),
            },
        );
        assert_eq!(e.connect_kind, Some(ConnectErrorKind::SshHostUnknown));
        assert_eq!(e.tunnel, Some(true));
        let prompt = e.host_key.expect("prompt");
        assert_eq!(prompt.fingerprint, "SHA256:seen");

        assert!(tunnels.trust("bastion", 22, "SHA256:other").is_err());
        tunnels.trust("bastion", 22, "SHA256:seen").expect("trust");
        assert_eq!(
            store
                .trusted_host_key("bastion", 22)
                .expect("get")
                .map(|k| k.fingerprint),
            Some("SHA256:seen".into())
        );
    }

    #[test]
    fn a_changed_key_reports_both_fingerprints() {
        let tunnels = Tunnels::new(Arc::new(Store::open_in_memory().expect("store")));
        let e = tunnels.error(
            "h",
            2222,
            SshError::HostChanged {
                expected: key("SHA256:old"),
                presented: key("SHA256:new"),
            },
        );
        assert_eq!(e.connect_kind, Some(ConnectErrorKind::SshHostChanged));
        let prompt = e.host_key.expect("prompt");
        assert_eq!(
            (prompt.fingerprint.as_str(), prompt.expected.as_deref()),
            ("SHA256:new", Some("SHA256:old"))
        );
    }
}
