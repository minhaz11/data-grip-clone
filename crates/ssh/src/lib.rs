//! SSH tunnels for database connections (REQ-CONN-07): a local port forward over a pure-Rust SSH
//! client (`russh`), so no system OpenSSH is needed.
//!
//! [`Tunnel::open`] connects and authenticates, checks the server's host key against keys the user
//! trusted before, proves the server can reach the database endpoint, and then listens on an
//! ephemeral `127.0.0.1` port. Each local connection becomes one `direct-tcpip` channel. Dropping
//! the tunnel stops the listener and disconnects; when the SSH connection drops, every forwarded
//! connection ends with it, so database sessions over it are reported lost.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use quarry_secrets::SecretString;
use russh::client::{self, AuthResult, Handle};
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::AgentClient;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// How to log in to the SSH server.
pub enum SshAuth {
    /// `None` when no password is stored or given: opening fails with `SecretRequired`.
    Password(Option<SecretString>),
    /// A private key file (OpenSSH or PEM), with its passphrase if it is encrypted.
    Key {
        path: PathBuf,
        passphrase: Option<SecretString>,
    },
    /// Keys held by the running SSH agent (`SSH_AUTH_SOCK`; the OpenSSH agent pipe or Pageant on
    /// Windows).
    Agent,
}

pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub connect_timeout: Duration,
}

/// A server host key as shown to the user: algorithm and SHA-256 fingerprint (OpenSSH format).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKey {
    pub algorithm: String,
    pub fingerprint: String,
}

impl HostKey {
    pub fn of(key: &PublicKey) -> Self {
        Self {
            algorithm: key.algorithm().as_str().to_owned(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        }
    }
}

/// Host keys the user trusted, by SSH endpoint.
pub trait KnownHosts: Send + Sync {
    fn lookup(&self, host: &str, port: u16) -> Result<Option<HostKey>, String>;
}

#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("Could not resolve SSH host \"{host}\" ({detail}).")]
    Dns { host: String, detail: String },
    #[error("SSH server {endpoint} refused the connection ({detail}).")]
    Refused { endpoint: String, detail: String },
    #[error("No answer from SSH server {endpoint} within {secs}s.")]
    Timeout { endpoint: String, secs: u64 },
    #[error("The SSH server's host key is not trusted yet ({} {}).", .presented.algorithm, .presented.fingerprint)]
    HostUnknown { presented: HostKey },
    #[error(
        "The SSH server's host key changed: expected {}, got {} {}.",
        .expected.fingerprint, .presented.algorithm, .presented.fingerprint
    )]
    HostChanged {
        expected: HostKey,
        presented: HostKey,
    },
    #[error("{0}")]
    Auth(String),
    /// The password or key passphrase is needed and was not given.
    #[error("{0}")]
    SecretRequired(String),
    #[error("{0}")]
    Key(String),
    #[error("{0}")]
    Agent(String),
    #[error("The SSH server could not open a connection to {endpoint}: {detail}.")]
    Forward { endpoint: String, detail: String },
    #[error("SSH failed: {0}.")]
    Other(String),
}

/// What the host key check decided, kept so a refused handshake reports why.
#[derive(Default)]
struct Verdict(Mutex<Option<SshError>>);

struct Client {
    host: String,
    port: u16,
    expected: Option<HostKey>,
    verdict: Arc<Verdict>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let russh::keys::PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            *self.verdict.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(SshError::Other(
                "SSH host certificates are not supported; the server must offer a plain host key"
                    .into(),
            ));
            return Ok(false);
        };
        let presented = HostKey::of(key);
        let refusal = match &self.expected {
            Some(expected) if *expected == presented => None,
            Some(expected) => Some(SshError::HostChanged {
                expected: expected.clone(),
                presented,
            }),
            None => Some(SshError::HostUnknown { presented }),
        };
        if let Some(e) = &refusal {
            tracing::warn!(host = %self.host, port = self.port, error = %e, "ssh host key refused");
        }
        let accepted = refusal.is_none();
        *self.verdict.0.lock().unwrap_or_else(|p| p.into_inner()) = refusal;
        Ok(accepted)
    }
}

pub struct Tunnel {
    local: SocketAddr,
    handle: Arc<Handle<Client>>,
    listener: JoinHandle<()>,
}

impl Tunnel {
    /// Opens a tunnel to `remote_host:remote_port` as seen from the SSH server.
    pub async fn open(
        target: &SshTarget,
        known: &dyn KnownHosts,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<Self, SshError> {
        let expected = known
            .lookup(&target.host, target.port)
            .map_err(SshError::Other)?;
        let endpoint = format!("{}:{}", target.host, target.port);
        let secs = target.connect_timeout.as_secs();
        let handle = tokio::time::timeout(target.connect_timeout, connect(target, expected))
            .await
            .map_err(|_| SshError::Timeout {
                endpoint: endpoint.clone(),
                secs,
            })??;
        let handle = Arc::new(handle);

        // Prove the forward works now, so an unreachable database is reported as such and not as
        // a connection the database driver sees closing.
        let remote = format!("{remote_host}:{remote_port}");
        let probe = tokio::time::timeout(
            target.connect_timeout,
            handle.channel_open_direct_tcpip(remote_host, remote_port.into(), "127.0.0.1", 0),
        )
        .await
        .map_err(|_| SshError::Forward {
            endpoint: remote.clone(),
            detail: format!("no answer within {secs}s"),
        })?
        .map_err(|e| SshError::Forward {
            endpoint: remote.clone(),
            detail: forward_detail(&e),
        })?;
        let _ = probe.close().await;

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| SshError::Other(format!("cannot listen on 127.0.0.1: {e}")))?;
        let local = listener
            .local_addr()
            .map_err(|e| SshError::Other(e.to_string()))?;
        let listener = tokio::spawn(forward(
            listener,
            Arc::clone(&handle),
            remote_host.to_owned(),
            remote_port,
        ));
        tracing::info!(ssh = %endpoint, local = %local, "ssh tunnel open");
        Ok(Self {
            local,
            handle,
            listener,
        })
    }

    /// Where the database driver connects instead of the remote endpoint.
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.listener.abort();
        let handle = Arc::clone(&self.handle);
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let _ = handle
                    .disconnect(russh::Disconnect::ByApplication, "", "en")
                    .await;
            });
        }
        tracing::info!(local = %self.local, "ssh tunnel closed");
    }
}

fn forward_detail(e: &russh::Error) -> String {
    match e {
        russh::Error::ChannelOpenFailure(reason) => match reason {
            russh::ChannelOpenFailure::AdministrativelyProhibited => {
                "port forwarding is not allowed for this user (AllowTcpForwarding)".into()
            }
            russh::ChannelOpenFailure::ConnectFailed => {
                "the connection was refused or the host is unreachable from the SSH server".into()
            }
            other => format!("{other:?}"),
        },
        other => other.to_string(),
    }
}

async fn connect(
    target: &SshTarget,
    expected: Option<HostKey>,
) -> Result<Handle<Client>, SshError> {
    let endpoint = format!("{}:{}", target.host, target.port);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((target.host.as_str(), target.port))
        .await
        .map_err(|e| SshError::Dns {
            host: target.host.clone(),
            detail: e.to_string(),
        })?
        .collect();
    let mut last = None;
    let mut stream = None;
    for addr in addrs {
        match TcpStream::connect(addr).await {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(e) => last = Some(e),
        }
    }
    let stream = stream.ok_or_else(|| SshError::Refused {
        endpoint: endpoint.clone(),
        detail: last.map_or_else(|| "no addresses".into(), |e| e.to_string()),
    })?;
    let _ = stream.set_nodelay(true);

    let config = Arc::new(client::Config {
        // Notice a dead server or network within about a minute; the database driver then sees
        // its connection end and the session is marked lost.
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });
    let verdict = Arc::new(Verdict::default());
    let handler = Client {
        host: target.host.clone(),
        port: target.port,
        expected,
        verdict: Arc::clone(&verdict),
    };
    let mut handle = match client::connect_stream(config, stream, handler).await {
        Ok(h) => h,
        Err(e) => {
            if let Some(refused) = verdict.0.lock().unwrap_or_else(|p| p.into_inner()).take() {
                return Err(refused);
            }
            return Err(SshError::Other(format!("handshake with {endpoint}: {e}")));
        }
    };
    authenticate(&mut handle, target).await?;
    Ok(handle)
}

fn auth_failed(target: &SshTarget, how: &str) -> SshError {
    SshError::Auth(format!(
        "The SSH server rejected user \"{}\" with {how}.",
        target.username
    ))
}

async fn authenticate(handle: &mut Handle<Client>, target: &SshTarget) -> Result<(), SshError> {
    let other = |e: russh::Error| SshError::Other(e.to_string());
    let user = target.username.clone();
    match &target.auth {
        SshAuth::Password(None) => {
            return Err(SshError::SecretRequired(format!(
                "Enter the SSH password for {}@{}.",
                target.username, target.host
            )));
        }
        SshAuth::Password(Some(pw)) => {
            let r = handle
                .authenticate_password(user, pw.expose())
                .await
                .map_err(other)?;
            if !r.success() {
                return Err(auth_failed(target, "this password"));
            }
        }
        SshAuth::Key { path, passphrase } => {
            let key = load_key(path, passphrase.as_ref())?;
            let hash = handle.best_supported_rsa_hash().await.map_err(other)?;
            let r = handle
                .authenticate_publickey(
                    user,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash.flatten()),
                )
                .await
                .map_err(other)?;
            if !r.success() {
                return Err(auth_failed(target, "this key"));
            }
        }
        SshAuth::Agent => agent_auth(handle, target).await?,
    }
    Ok(())
}

/// Loads a private key. An encrypted key without a passphrase, or with a wrong one, is an
/// authentication problem the user can fix by entering the right passphrase.
fn load_key(
    path: &std::path::Path,
    passphrase: Option<&SecretString>,
) -> Result<russh::keys::PrivateKey, SshError> {
    let shown = path.display();
    match russh::keys::load_secret_key(path, None) {
        Ok(key) => Ok(key),
        Err(russh::keys::Error::KeyIsEncrypted) => match passphrase {
            None => Err(SshError::SecretRequired(format!(
                "The key file {shown} is encrypted: enter its passphrase."
            ))),
            Some(p) => russh::keys::load_secret_key(path, Some(p.expose())).map_err(|_| {
                SshError::Auth(format!("The passphrase for key file {shown} is wrong."))
            }),
        },
        Err(russh::keys::Error::IO(e)) => Err(SshError::Key(format!(
            "The key file {shown} cannot be read ({e})."
        ))),
        Err(e) => Err(SshError::Key(format!(
            "The key file {shown} is not a usable private key ({e})."
        ))),
    }
}

#[cfg(unix)]
async fn agent_auth(handle: &mut Handle<Client>, target: &SshTarget) -> Result<(), SshError> {
    let agent = AgentClient::connect_env().await.map_err(|e| {
        SshError::Agent(format!(
            "No SSH agent is available ({e}). Start ssh-agent and add your key, or use a key file."
        ))
    })?;
    try_agent(handle, target, agent).await
}

#[cfg(windows)]
async fn agent_auth(handle: &mut Handle<Client>, target: &SshTarget) -> Result<(), SshError> {
    // The OpenSSH agent service first, then Pageant.
    if let Ok(agent) = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        return try_agent(handle, target, agent).await;
    }
    let agent = AgentClient::connect_pageant().await.map_err(|e| {
        SshError::Agent(format!(
            "No SSH agent is available (OpenSSH agent service or Pageant: {e}). Use a key file instead."
        ))
    })?;
    try_agent(handle, target, agent).await
}

async fn try_agent<S>(
    handle: &mut Handle<Client>,
    target: &SshTarget,
    mut agent: AgentClient<S>,
) -> Result<(), SshError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| SshError::Agent(format!("The SSH agent did not list its keys ({e}).")))?;
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(|e| SshError::Other(e.to_string()))?
        .flatten();
    let mut tried = 0;
    for identity in identities {
        let AgentIdentity::PublicKey { key, .. } = identity else {
            continue;
        };
        tried += 1;
        let result = handle
            .authenticate_publickey_with(target.username.clone(), key, hash, &mut agent)
            .await
            .map_err(|e| SshError::Agent(format!("The SSH agent could not sign ({e:?}).")))?;
        if let AuthResult::Success = result {
            return Ok(());
        }
    }
    Err(if tried == 0 {
        SshError::Agent("The SSH agent holds no keys. Add one with ssh-add.".into())
    } else {
        auth_failed(target, &format!("any of the agent's {tried} key(s)"))
    })
}

/// Accepts local connections and forwards each one over its own `direct-tcpip` channel.
async fn forward(
    listener: TcpListener,
    handle: Arc<Handle<Client>>,
    remote_host: String,
    remote_port: u16,
) {
    loop {
        let (mut socket, peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                tracing::warn!(error = %e, "ssh tunnel stopped accepting");
                return;
            }
        };
        let handle = Arc::clone(&handle);
        let remote_host = remote_host.clone();
        tokio::spawn(async move {
            let channel = match handle
                .channel_open_direct_tcpip(
                    remote_host.as_str(),
                    remote_port.into(),
                    peer.ip().to_string(),
                    peer.port().into(),
                )
                .await
            {
                Ok(c) => c,
                Err(e) => {
                    // Dropping the socket tells the driver the connection failed.
                    tracing::warn!(error = %forward_detail(&e), "ssh forward refused");
                    return;
                }
            };
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_key_errors_name_the_fingerprints() {
        let a = HostKey {
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:aaa".into(),
        };
        let b = HostKey {
            algorithm: "ssh-ed25519".into(),
            fingerprint: "SHA256:bbb".into(),
        };
        let unknown = SshError::HostUnknown {
            presented: a.clone(),
        };
        assert!(unknown.to_string().contains("ssh-ed25519 SHA256:aaa"));
        let changed = SshError::HostChanged {
            expected: a,
            presented: b,
        };
        let text = changed.to_string();
        assert!(
            text.contains("SHA256:aaa") && text.contains("SHA256:bbb"),
            "{text}"
        );
    }

    #[test]
    fn missing_key_file_is_a_key_error() {
        let err =
            load_key(std::path::Path::new("/nonexistent/quarry-key"), None).expect_err("missing");
        assert!(matches!(err, SshError::Key(_)), "{err:?}");
    }
}
