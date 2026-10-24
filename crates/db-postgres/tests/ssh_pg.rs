//! SSH tunnels end to end: the disposable server behind the disposable SSH container
//! (`scripts/test-pg.sh up`), reached at `pg:5432` from the SSH server's side.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use quarry_db_core::{
    ConnectOptions, ConnectParams, DatabaseAdapter, ExecOptions, Session, StatementOutcome, TlsMode,
};
use quarry_db_postgres::PostgresAdapter;
use quarry_io::{ExportOutcome, Format, WriteOptions, export_to_file};
use quarry_secrets::SecretString;
use quarry_ssh::{HostKey, KnownHosts, SshAuth, SshError, SshTarget, Tunnel};

/// One test at a time: the lost-connection test kills every SSH session of the test user.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/test-pg")
}

fn read(name: &str) -> String {
    let path = dir().join(name);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (run scripts/test-pg.sh up)", path.display()))
        .trim()
        .to_owned()
}

/// Host keys as a fixed answer.
struct Known(Option<HostKey>);

impl KnownHosts for Known {
    fn lookup(&self, _host: &str, _port: u16) -> Result<Option<HostKey>, String> {
        Ok(self.0.clone())
    }
}

fn trusted() -> Known {
    Known(Some(HostKey {
        algorithm: "ssh-ed25519".into(),
        fingerprint: read("ssh/host_fingerprint"),
    }))
}

fn target(auth: SshAuth) -> SshTarget {
    SshTarget {
        host: "127.0.0.1".into(),
        port: 52222,
        username: "quarry".into(),
        auth,
        connect_timeout: Duration::from_secs(10),
    }
}

fn key_auth() -> SshAuth {
    SshAuth::Key {
        path: dir().join("ssh/id_ed25519"),
        passphrase: None,
    }
}

async fn tunnel(auth: SshAuth) -> Tunnel {
    Tunnel::open(&target(auth), &trusted(), "pg", 5432)
        .await
        .expect("tunnel")
}

/// Database parameters as the app builds them: the real endpoint (seen from the SSH server) as
/// host and port, the tunnel's local end as the dial address, and the tunnel as the guard.
fn through(tunnel: Tunnel, application_name: &str) -> ConnectParams {
    ConnectParams {
        host: "pg".into(),
        port: 5432,
        database: "quarry_test".into(),
        username: "quarry".into(),
        password: Some(SecretString::new(read("password"))),
        tls: TlsMode::Prefer,
        connect_timeout: Duration::from_secs(10),
        read_only: false,
        application_name: application_name.into(),
        options: ConnectOptions {
            dial: Some(tunnel.local_addr()),
            guard: Some(Arc::new(tunnel)),
            ..Default::default()
        },
    }
}

async fn scalar(s: &Arc<dyn Session>, sql: &str) -> Option<String> {
    match s.execute(sql, &ExecOptions::default()).await.expect(sql) {
        StatementOutcome::Rows { rows, .. } => rows.into_iter().next().and_then(|r| r[0].clone()),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn a_tunnelled_session_queries_cancels_and_exports_like_a_direct_one() {
    let _serial = SERIAL.lock().await;
    let params = through(tunnel(key_auth()).await, "quarry-it-ssh");
    let s = PostgresAdapter
        .connect(&params, Box::new(|_| {}))
        .await
        .expect("connect");
    drop(params); // the session's own copy keeps the tunnel open
    assert_eq!(scalar(&s, "select 40 + 2").await.as_deref(), Some("42"));
    // The server sees the connection coming from the SSH container, not from this machine.
    let client = scalar(&s, "select host(inet_client_addr())").await;
    assert!(
        client.as_deref().is_some_and(|a| a != "127.0.0.1"),
        "{client:?}"
    );

    // Cancel opens its own connection: it must go through the tunnel too.
    let runner = {
        let s = Arc::clone(&s);
        tokio::spawn(async move {
            s.execute("select pg_sleep(30)", &ExecOptions::default())
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(400)).await;
    let cancel_at = Instant::now();
    s.cancel().await.expect("cancel delivered");
    let e = runner.await.expect("join").expect_err("cancelled");
    assert!(e.cancelled, "{e:?}");
    assert!(cancel_at.elapsed() < Duration::from_secs(2));

    // Export streams cursor pages over the same tunnel.
    let (columns, cursor) = match s
        .execute(
            "select g as id, 'row ' || g as label from generate_series(1, 20000) g",
            &ExecOptions::default(),
        )
        .await
        .expect("query")
    {
        StatementOutcome::Rows {
            columns, cursor, ..
        } => (columns, cursor.expect("cursor")),
        other => panic!("{other:?}"),
    };
    let out = tempfile::tempdir().expect("tempdir");
    let path = out.path().join("rows.csv");
    let outcome = export_to_file(
        s.as_ref(),
        &cursor,
        &columns,
        Format::Csv,
        &WriteOptions::default(),
        &path,
        &AtomicBool::new(false),
        &|_| {},
    )
    .await
    .expect("export");
    assert!(
        matches!(outcome, ExportOutcome::Written { rows: 20_000, .. }),
        "{outcome:?}"
    );

    // Forks (a console's own session) share the tunnel.
    let fork = s.fork(Box::new(|_| {})).await.expect("fork");
    assert_eq!(
        scalar(&fork, "select 'forked'").await.as_deref(),
        Some("forked")
    );
    fork.close().await;
    s.close().await;
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn password_and_passphrase_logins() {
    let _serial = SERIAL.lock().await;
    let ok = Tunnel::open(
        &target(SshAuth::Password(Some(SecretString::new(read(
            "ssh/password",
        ))))),
        &trusted(),
        "pg",
        5432,
    )
    .await;
    assert!(ok.is_ok(), "password login: {:?}", ok.err());

    let no_password = Tunnel::open(&target(SshAuth::Password(None)), &trusted(), "pg", 5432)
        .await
        .err();
    assert!(
        matches!(no_password, Some(SshError::SecretRequired(_))),
        "{no_password:?}"
    );

    let wrong_password = Tunnel::open(
        &target(SshAuth::Password(Some(SecretString::new("nope".into())))),
        &trusted(),
        "pg",
        5432,
    )
    .await
    .err();
    assert!(
        matches!(wrong_password, Some(SshError::Auth(_))),
        "{wrong_password:?}"
    );

    let encrypted = |passphrase: Option<&str>| SshAuth::Key {
        path: dir().join("ssh/id_ed25519_enc"),
        passphrase: passphrase.map(|p| SecretString::new(p.into())),
    };
    let missing = Tunnel::open(&target(encrypted(None)), &trusted(), "pg", 5432)
        .await
        .err();
    assert!(
        matches!(missing, Some(SshError::SecretRequired(_))),
        "{missing:?}"
    );
    let wrong = Tunnel::open(&target(encrypted(Some("wrong"))), &trusted(), "pg", 5432)
        .await
        .err();
    assert!(
        matches!(wrong, Some(SshError::Auth(ref m)) if m.contains("passphrase")),
        "{wrong:?}"
    );
    let right = Tunnel::open(
        &target(encrypted(Some(&read("ssh/passphrase")))),
        &trusted(),
        "pg",
        5432,
    )
    .await;
    assert!(right.is_ok(), "passphrase login: {:?}", right.err());
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn unknown_and_changed_host_keys_are_refused() {
    let _serial = SERIAL.lock().await;
    let fingerprint = read("ssh/host_fingerprint");
    match Tunnel::open(&target(key_auth()), &Known(None), "pg", 5432).await {
        Err(SshError::HostUnknown { presented }) => {
            assert_eq!(presented.fingerprint, fingerprint);
            assert_eq!(presented.algorithm, "ssh-ed25519");
        }
        other => panic!("{:?}", other.err()),
    }
    let impostor = HostKey {
        algorithm: "ssh-ed25519".into(),
        fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
    };
    match Tunnel::open(
        &target(key_auth()),
        &Known(Some(impostor.clone())),
        "pg",
        5432,
    )
    .await
    {
        Err(SshError::HostChanged {
            expected,
            presented,
        }) => {
            assert_eq!(expected, impostor);
            assert_eq!(presented.fingerprint, fingerprint);
        }
        other => panic!("{:?}", other.err()),
    }
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn an_unreachable_database_behind_the_tunnel_is_reported() {
    let _serial = SERIAL.lock().await;
    let err = Tunnel::open(&target(key_auth()), &trusted(), "pg", 1)
        .await
        .err();
    assert!(
        matches!(err, Some(SshError::Forward { ref endpoint, .. }) if endpoint == "pg:1"),
        "{err:?}"
    );
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn losing_the_ssh_connection_marks_the_session_lost() {
    let _serial = SERIAL.lock().await;
    let params = through(tunnel(key_auth()).await, "quarry-it-ssh-lost");
    let reason: Arc<Mutex<Option<Option<String>>>> = Arc::default();
    let s = {
        let reason = Arc::clone(&reason);
        PostgresAdapter
            .connect(
                &params,
                Box::new(move |r| *reason.lock().expect("lock") = Some(r)),
            )
            .await
            .expect("connect")
    };
    drop(params);
    assert_eq!(scalar(&s, "select 1").await.as_deref(), Some("1"));

    // Kill the SSH session on the server side (the per-connection process runs as "quarry").
    let killed = std::process::Command::new("docker")
        .args([
            "exec",
            "quarry-test-ssh",
            "sh",
            "-c",
            "ps -o pid,user | awk '$2 == \"quarry\" {print $1}' | xargs -r kill",
        ])
        .status()
        .expect("docker exec");
    assert!(killed.success());

    let deadline = Instant::now() + Duration::from_secs(10);
    while reason.lock().expect("lock").is_none() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let reported = reason.lock().expect("lock").clone();
    assert!(
        matches!(reported, Some(Some(_))),
        "the session must be reported lost, got {reported:?}"
    );
    assert!(s.is_closed());
    let e = s
        .execute("select 1", &ExecOptions::default())
        .await
        .expect_err("gone");
    assert!(e.connection_lost, "{e:?}");
}

/// Agent login, against a private `ssh-agent` holding the test key. The tunnel reads
/// `SSH_AUTH_SOCK`, which this process cannot change safely, so the test runs the agent part in a
/// child process of this test binary with the variable set.
#[cfg(unix)]
#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn agent_login_uses_the_running_agent() {
    let _serial = SERIAL.lock().await;
    let work = tempfile::tempdir().expect("tempdir");
    let socket = work.path().join("agent.sock");
    let mut agent = std::process::Command::new("ssh-agent")
        .args(["-D", "-a"])
        .arg(&socket)
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("ssh-agent");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !socket.exists() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let added = std::process::Command::new("ssh-add")
        .arg(dir().join("ssh/id_ed25519"))
        .env("SSH_AUTH_SOCK", &socket)
        .stderr(std::process::Stdio::null())
        .status()
        .expect("ssh-add");
    assert!(added.success());

    let child = std::process::Command::new(std::env::current_exe().expect("test binary"))
        .args(["--ignored", "--exact", "agent_child", "--nocapture"])
        .env("SSH_AUTH_SOCK", &socket)
        .env("QUARRY_AGENT_CHILD", "1")
        .output()
        .expect("child test");
    let _ = agent.kill();
    let _ = agent.wait();
    let out = String::from_utf8_lossy(&child.stdout);
    assert!(
        child.status.success() && out.contains("1 passed"),
        "{out}\n{}",
        String::from_utf8_lossy(&child.stderr)
    );
}

/// The child half of `agent_login_uses_the_running_agent`; does nothing on its own.
#[tokio::test]
#[ignore = "run by agent_login_uses_the_running_agent"]
async fn agent_child() {
    if std::env::var_os("QUARRY_AGENT_CHILD").is_none() {
        return;
    }
    let tunnel = Tunnel::open(&target(SshAuth::Agent), &trusted(), "pg", 5432)
        .await
        .expect("agent login");
    let s = PostgresAdapter
        .connect(&through(tunnel, "quarry-it-ssh-agent"), Box::new(|_| {}))
        .await
        .expect("connect");
    assert_eq!(scalar(&s, "select 'agent'").await.as_deref(), Some("agent"));
    s.close().await;
}
