//! Secrets never reach the log file. A separate test binary with a single test, so the global
//! subscriber sees every event (thread-local subscribers race with parallel tests over tracing's
//! per-callsite interest cache).

use std::sync::{Arc, Mutex};

use quarry_connections::{ConnectionManager, PasswordChange, connect_params};
use quarry_db_core::{Isolation, TxMode};
use quarry_logging::{LOG_FILE, RedactingWriter, RotatingFile, subscriber};
use quarry_secrets::{CredentialStore, MemoryStore, SecretError, SecretString};
use quarry_store::{ConnectionDraft, Engine, Environment, SaveMode, SslMode, Store};

const MARKER: &str = "LEAK-CANARY-log-5d1e";

/// Memory store that can be told to refuse writes, to exercise the failure path.
#[derive(Default)]
struct Keyring {
    inner: MemoryStore,
    refuse: Mutex<bool>,
}

impl CredentialStore for Keyring {
    fn set(&self, account: &str, s: &SecretString) -> Result<(), SecretError> {
        if *self.refuse.lock().expect("lock") {
            return Err(SecretError::Unavailable("locked".into()));
        }
        self.inner.set(account, s)
    }
    fn get(&self, account: &str) -> Result<Option<SecretString>, SecretError> {
        self.inner.get(account)
    }
    fn delete(&self, account: &str) -> Result<(), SecretError> {
        self.inner.delete(account)
    }
}

fn draft(name: &str, mode: SaveMode) -> ConnectionDraft {
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
        save_mode: mode,
        tx_mode: TxMode::Auto,
        isolation: Isolation::ReadCommitted,
    }
}

fn pw() -> SecretString {
    SecretString::new(MARKER.into())
}

#[test]
fn secrets_never_reach_the_log_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = RotatingFile::open(dir.path(), LOG_FILE, 1 << 20, 1).expect("log file");
    tracing::subscriber::set_global_default(subscriber(
        RedactingWriter::new(file, false),
        "trace".parse().expect("filter"),
    ))
    .expect("global subscriber");

    let keyring = Arc::new(Keyring::default());
    let m = ConnectionManager::new(
        Arc::new(Store::open_in_memory().expect("store")),
        keyring.clone(),
    );
    let a = m
        .create(draft("A", SaveMode::Forever), Some(pw()))
        .expect("create");
    let b = m
        .create(draft("B", SaveMode::UntilRestart), Some(pw()))
        .expect("create");
    m.update(
        &b.id,
        draft("B", SaveMode::Forever),
        PasswordChange::Set(pw()),
    )
    .expect("update");
    let copy = m.duplicate(&a.id).expect("duplicate");
    let secret = m.resolve_password(Some(&a.id), None).expect("resolve");
    connect_params(draft("A", SaveMode::Forever), secret).expect("params");
    m.delete(&copy.id).expect("delete");
    *keyring.refuse.lock().expect("lock") = true;
    m.create(draft("C", SaveMode::Forever), Some(pw()))
        .expect_err("keyring refuses");

    let text = std::fs::read_to_string(dir.path().join(LOG_FILE)).expect("read log");
    for expected in [
        "data source created",
        "data source updated",
        "data source deleted",
        "connect parameters",
        "credential store refused",
    ] {
        assert!(text.contains(expected), "missing {expected:?}:\n{text}");
    }
    assert!(
        !text.contains(MARKER),
        "secret reached the log file:\n{text}"
    );
}
