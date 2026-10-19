use std::sync::Mutex;

use quarry_store::{Engine, Environment, SslMode};

use super::*;

/// Credential store double that records calls and can be told to fail.
#[derive(Default)]
struct FakeKeyring {
    inner: MemoryStore,
    fail_writes: Mutex<bool>,
}

impl CredentialStore for FakeKeyring {
    fn set(&self, account: &str, s: &SecretString) -> Result<(), SecretError> {
        if *self.fail_writes.lock().expect("lock") {
            return Err(SecretError::Unavailable("locked".into()));
        }
        self.inner.set(account, s)
    }
    fn get(&self, account: &str) -> Result<Option<SecretString>, SecretError> {
        self.inner.get(account)
    }
    fn delete(&self, account: &str) -> Result<(), SecretError> {
        if *self.fail_writes.lock().expect("lock") {
            return Err(SecretError::Unavailable("locked".into()));
        }
        self.inner.delete(account)
    }
}

fn setup() -> (ConnectionManager, Arc<FakeKeyring>, Arc<Store>) {
    let store = Arc::new(Store::open_in_memory().expect("store"));
    let keyring = Arc::new(FakeKeyring::default());
    (
        ConnectionManager::new(Arc::clone(&store), keyring.clone()),
        keyring,
        store,
    )
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
    }
}

fn pw(s: &str) -> SecretString {
    SecretString::new(s.into())
}

fn secret_of(m: &ConnectionManager, id: &str) -> Option<String> {
    m.password_for_connect(id)
        .expect("password")
        .map(|s| s.expose().to_owned())
}

#[test]
fn forever_goes_to_keyring_and_sets_flag() {
    let (m, keyring, _) = setup();
    let p = m
        .create(draft("A", SaveMode::Forever), Some(pw("s3cret")))
        .expect("create");
    assert!(p.password_saved);
    assert_eq!(
        keyring
            .inner
            .get(&account(&p.id))
            .expect("get")
            .expect("some")
            .expose(),
        "s3cret"
    );
    assert_eq!(secret_of(&m, &p.id).as_deref(), Some("s3cret"));
}

#[test]
fn until_restart_stays_in_memory_only() {
    let (m, keyring, _) = setup();
    let p = m
        .create(draft("A", SaveMode::UntilRestart), Some(pw("tmp")))
        .expect("create");
    assert!(p.password_saved);
    assert!(keyring.inner.get(&account(&p.id)).expect("get").is_none());
    assert_eq!(secret_of(&m, &p.id).as_deref(), Some("tmp"));
    // A new manager over the same store simulates an app restart.
    let restarted = ConnectionManager::new(Arc::clone(&m.store), keyring);
    assert!(!restarted.list().expect("list")[0].password_saved);
    assert_eq!(
        restarted
            .password_for_connect(&p.id)
            .expect("pw")
            .map(|s| s.expose().to_owned()),
        None
    );
}

#[test]
fn never_mode_rejects_a_password() {
    let (m, _, _) = setup();
    assert!(matches!(
        m.create(draft("A", SaveMode::Never), Some(pw("x"))),
        Err(ConnectionError::Invalid(_))
    ));
    assert!(m.list().expect("list").is_empty());
}

#[test]
fn keyring_failure_rolls_back_create() {
    let (m, keyring, _) = setup();
    *keyring.fail_writes.lock().expect("lock") = true;
    let err = m
        .create(draft("A", SaveMode::Forever), Some(pw("x")))
        .expect_err("fails");
    assert!(err.to_string().contains("until restart"), "{err}");
    assert!(
        m.list().expect("list").is_empty(),
        "no half-created profile"
    );
}

#[test]
fn changing_save_mode_moves_the_existing_secret() {
    let (m, keyring, _) = setup();
    let p = m
        .create(draft("A", SaveMode::Forever), Some(pw("move-me")))
        .expect("create");

    let to_session = m
        .update(
            &p.id,
            draft("A", SaveMode::UntilRestart),
            PasswordChange::Keep,
        )
        .expect("update");
    assert!(to_session.password_saved);
    assert!(
        keyring.inner.get(&account(&p.id)).expect("get").is_none(),
        "removed from keyring"
    );
    assert_eq!(secret_of(&m, &p.id).as_deref(), Some("move-me"));

    let to_never = m
        .update(&p.id, draft("A", SaveMode::Never), PasswordChange::Keep)
        .expect("update");
    assert!(!to_never.password_saved);
    assert_eq!(secret_of(&m, &p.id), None);
    assert!(
        m.session.get(&account(&p.id)).expect("get").is_none(),
        "removed from memory"
    );
}

#[test]
fn set_and_clear_password() {
    let (m, _, _) = setup();
    let p = m
        .create(draft("A", SaveMode::Forever), None)
        .expect("create");
    assert!(!p.password_saved);
    let set = m
        .update(
            &p.id,
            draft("A", SaveMode::Forever),
            PasswordChange::Set(pw("new")),
        )
        .expect("set");
    assert!(set.password_saved);
    assert_eq!(secret_of(&m, &p.id).as_deref(), Some("new"));
    let cleared = m
        .update(&p.id, draft("A", SaveMode::Forever), PasswordChange::Clear)
        .expect("clear");
    assert!(!cleared.password_saved);
    assert_eq!(secret_of(&m, &p.id), None);
}

#[test]
fn invalid_update_leaves_secret_untouched() {
    let (m, _, _) = setup();
    let p = m
        .create(draft("A", SaveMode::Forever), Some(pw("keep")))
        .expect("create");
    let mut bad = draft("A", SaveMode::Forever);
    bad.port = 0;
    assert!(m.update(&p.id, bad, PasswordChange::Clear).is_err());
    assert_eq!(secret_of(&m, &p.id).as_deref(), Some("keep"));
}

#[test]
fn duplicate_copies_settings_and_password_under_new_name() {
    let (m, _, _) = setup();
    let mut d = draft("Prod", SaveMode::Forever);
    d.read_only = true;
    d.environment = Environment::Production;
    let p = m.create(d, Some(pw("dup"))).expect("create");
    let copy = m.duplicate(&p.id).expect("duplicate");
    assert_ne!(copy.id, p.id);
    assert_eq!(copy.draft.name, "Prod (copy)");
    assert!(copy.draft.read_only);
    assert_eq!(copy.draft.environment, Environment::Production);
    assert_eq!(secret_of(&m, &copy.id).as_deref(), Some("dup"));
}

#[test]
fn delete_removes_secret_and_aborts_if_keyring_refuses() {
    let (m, keyring, _) = setup();
    let p = m
        .create(draft("A", SaveMode::Forever), Some(pw("bye")))
        .expect("create");

    *keyring.fail_writes.lock().expect("lock") = true;
    assert!(m.delete(&p.id).is_err());
    assert_eq!(
        m.list().expect("list").len(),
        1,
        "profile kept when secret could not be removed"
    );

    *keyring.fail_writes.lock().expect("lock") = false;
    m.delete(&p.id).expect("delete");
    assert!(m.list().expect("list").is_empty());
    assert!(keyring.inner.get(&account(&p.id)).expect("get").is_none());
    assert!(matches!(m.delete(&p.id), Err(ConnectionError::NotFound)));
}

#[test]
fn secrets_never_reach_app_db_or_serialized_profiles() {
    let dir = std::env::temp_dir().join(format!("quarry-leak-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("dir");
    let path = dir.join("app.db");
    let marker = "LEAK-CANARY-7f3a9c";
    {
        let store = Arc::new(Store::open(&path).expect("store"));
        let m = ConnectionManager::new(store, Arc::new(FakeKeyring::default()));
        let a = m
            .create(draft("A", SaveMode::Forever), Some(pw(marker)))
            .expect("create");
        let b = m
            .create(draft("B", SaveMode::UntilRestart), Some(pw(marker)))
            .expect("create");
        m.duplicate(&a.id).expect("dup");
        m.update(&b.id, draft("B", SaveMode::Forever), PasswordChange::Keep)
            .expect("move");
        let listed = serde_json::to_string(&m.list().expect("list")).expect("json");
        assert!(!listed.contains(marker), "secret in serialized profiles");
        let debug = format!(
            "{:?} {:?}",
            m.list().expect("list"),
            PasswordChange::Set(pw(marker))
        );
        assert!(!debug.contains(marker), "secret in Debug output");
    }
    for entry in std::fs::read_dir(&dir).expect("read dir") {
        let bytes = std::fs::read(entry.expect("entry").path()).expect("read");
        assert!(
            !String::from_utf8_lossy(&bytes).contains(marker),
            "secret written to app.db/WAL"
        );
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn password_change_json_shape() {
    let keep: PasswordChange = serde_json::from_str(r#"{"action":"keep"}"#).expect("keep");
    assert!(matches!(keep, PasswordChange::Keep));
    let set: PasswordChange = serde_json::from_str(r#"{"action":"set","value":"p"}"#).expect("set");
    assert!(matches!(set, PasswordChange::Set(s) if s.expose() == "p"));
    let clear: PasswordChange = serde_json::from_str(r#"{"action":"clear"}"#).expect("clear");
    assert!(matches!(clear, PasswordChange::Clear));
}

#[test]
fn resolve_password_prefers_explicit_then_stored() {
    let (m, _, _) = setup();
    let p = m
        .create(draft("A", SaveMode::Forever), Some(pw("stored")))
        .expect("create");
    let got = |id: Option<&str>, explicit: Option<&str>| {
        m.resolve_password(id, explicit.map(pw))
            .expect("resolve")
            .map(|s| s.expose().to_owned())
    };
    assert_eq!(got(Some(&p.id), Some("typed")).as_deref(), Some("typed"));
    assert_eq!(got(Some(&p.id), None).as_deref(), Some("stored"));
    assert_eq!(got(None, None), None);
}

#[test]
fn connect_params_map_profile_fields() {
    let mut d = draft("A", SaveMode::Never);
    d.ssl_mode = SslMode::VerifyFull;
    d.read_only = true;
    d.connect_timeout_secs = 7;
    let p = connect_params(d, None).expect("params");
    assert_eq!(p.tls, quarry_db_core::TlsMode::VerifyFull);
    assert!(p.read_only);
    assert_eq!(p.connect_timeout, std::time::Duration::from_secs(7));
    let mut bad = draft("A", SaveMode::Never);
    bad.port = 0;
    assert!(connect_params(bad, None).is_err());
}
