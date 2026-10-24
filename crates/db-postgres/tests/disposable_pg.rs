//! Integration tests against the disposable container from `scripts/test-pg.sh up`.
//! Run: `scripts/test-pg.sh up && cargo test -p quarry-db-postgres -- --ignored`

use std::sync::{Arc, Mutex};
use std::time::Duration;

use quarry_db_core::{ConnectErrorKind as Kind, ConnectParams, DatabaseAdapter, TlsMode};
use quarry_db_postgres::PostgresAdapter;
use quarry_secrets::SecretString;

const PORT: u16 = 55432;

/// Parameters for the disposable server. Refuses anything but loopback:55432 so these tests can
/// never touch a developer's real databases.
fn params() -> ConnectParams {
    let host = std::env::var("QUARRY_TEST_PG_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("QUARRY_TEST_PG_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(PORT);
    assert!(
        host == "127.0.0.1" && port == PORT,
        "integration tests only run against 127.0.0.1:{PORT}"
    );
    let pw_file = std::env::var("QUARRY_TEST_PG_PASSWORD_FILE").unwrap_or_else(|_| {
        format!(
            "{}/../../target/test-pg/password",
            env!("CARGO_MANIFEST_DIR")
        )
    });
    let password = std::fs::read_to_string(&pw_file)
        .unwrap_or_else(|e| panic!("{pw_file}: {e} (run scripts/test-pg.sh up)"))
        .trim()
        .to_owned();
    ConnectParams {
        host,
        port,
        database: "quarry_test".into(),
        username: "quarry".into(),
        password: Some(SecretString::new(password)),
        tls: TlsMode::Disable,
        connect_timeout: Duration::from_secs(5),
        read_only: false,
        application_name: "quarry-it".into(),
        options: Default::default(),
    }
}

async fn kind_of(p: ConnectParams) -> Kind {
    match PostgresAdapter.test(&p).await {
        Ok(info) => panic!("expected failure, connected: {info:?}"),
        Err(e) => {
            assert!(!e.hint.is_empty(), "every error needs a hint: {e:?}");
            e.kind
        }
    }
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn connects_with_each_tls_mode() {
    for (mode, expect_tls) in [
        (TlsMode::Disable, false),
        (TlsMode::Prefer, true),
        (TlsMode::Require, true),
    ] {
        let info = PostgresAdapter
            .test(&ConnectParams {
                tls: mode,
                ..params()
            })
            .await
            .expect("connect");
        assert!(info.version.starts_with("PostgreSQL 16"), "{info:?}");
        assert_eq!(
            (info.database.as_str(), info.user.as_str()),
            ("quarry_test", "quarry")
        );
        assert_eq!(info.tls, expect_tls, "{mode:?}");
    }
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn wrong_password_is_auth() {
    let p = ConnectParams {
        password: Some(SecretString::new("wrong".into())),
        ..params()
    };
    assert_eq!(kind_of(p).await, Kind::Auth);
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn missing_password_asks_for_one() {
    assert_eq!(
        kind_of(ConnectParams {
            password: None,
            ..params()
        })
        .await,
        Kind::PasswordRequired
    );
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn unknown_database_is_reported() {
    let err = PostgresAdapter
        .test(&ConnectParams {
            database: "nope_db".into(),
            ..params()
        })
        .await
        .expect_err("fails");
    assert_eq!(err.kind, Kind::DatabaseMissing);
    assert_eq!(err.sqlstate.as_deref(), Some("3D000"));
    assert!(err.hint.contains("nope_db"));
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn closed_port_is_refused() {
    // Bind then release a port so we know nothing listens on it.
    let free = std::net::TcpListener::bind("127.0.0.1:0")
        .expect("bind")
        .local_addr()
        .expect("addr")
        .port();
    let p = ConnectParams {
        port: free,
        ..params()
    };
    // `params()` asserts the port; build the closed-port variant after that check.
    assert_eq!(kind_of(p).await, Kind::Refused);
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn unresolvable_host_is_dns() {
    // `.invalid` is reserved and never resolves (RFC 2606).
    let p = ConnectParams {
        host: "quarry-does-not-exist.invalid".into(),
        ..params()
    };
    assert_eq!(kind_of(p).await, Kind::Dns);
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn blackholed_address_times_out() {
    // TEST-NET-1 (RFC 5737) is not routed; packets are dropped, so the connect hangs until timeout.
    let p = ConnectParams {
        host: "192.0.2.1".into(),
        connect_timeout: Duration::from_secs(1),
        ..params()
    };
    let started = std::time::Instant::now();
    let kind = kind_of(p).await;
    // Some networks answer "unreachable" immediately instead of dropping; both are acceptable
    // outcomes for this address, but neither may hang past the timeout.
    assert!(matches!(kind, Kind::Timeout | Kind::Other), "{kind:?}");
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn self_signed_certificate_fails_full_verification() {
    let err = PostgresAdapter
        .test(&ConnectParams {
            tls: TlsMode::VerifyFull,
            ..params()
        })
        .await
        .expect_err("fails");
    assert_eq!(err.kind, Kind::Tls, "{err:?}");
    assert!(err.hint.contains("Require"), "{err:?}");
    let err = PostgresAdapter
        .test(&ConnectParams {
            tls: TlsMode::VerifyCa,
            ..params()
        })
        .await
        .expect_err("fails");
    assert_eq!(err.kind, Kind::Tls, "{err:?}");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn read_only_sessions_are_read_only_server_side() {
    let info = PostgresAdapter
        .test(&ConnectParams {
            read_only: true,
            ..params()
        })
        .await
        .expect("connect");
    assert!(info.read_only);
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn session_reports_deliberate_and_unexpected_close() {
    let reason: Arc<Mutex<Option<Option<String>>>> = Arc::default();
    let r = Arc::clone(&reason);
    let app = "quarry-it-lifecycle";
    let p = ConnectParams {
        application_name: app.into(),
        options: Default::default(),
        ..params()
    };
    let session = PostgresAdapter
        .connect(
            &p,
            Box::new(move |why| *r.lock().expect("lock") = Some(why)),
        )
        .await
        .expect("connect");
    assert!(!session.is_closed());

    // Kill the backend from a second connection to simulate a server-side drop.
    let p2 = params();
    let mut cfg = tokio_postgres::Config::new();
    cfg.host(&p2.host)
        .port(p2.port)
        .user(&p2.username)
        .dbname(&p2.database)
        .password(p2.password.as_ref().expect("pw").expose());
    let (admin, conn) = cfg
        .connect(tokio_postgres::NoTls)
        .await
        .expect("admin connect");
    tokio::spawn(conn);
    admin
        .execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
            &[&app],
        )
        .await
        .expect("terminate");

    for _ in 0..50 {
        if reason.lock().expect("lock").is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let got = reason.lock().expect("lock").clone();
    assert!(
        matches!(got, Some(Some(_))),
        "expected an unexpected-close reason, got {got:?}"
    );
    assert!(session.is_closed());

    // A deliberate close reports no reason.
    let reason2: Arc<Mutex<Option<Option<String>>>> = Arc::default();
    let r2 = Arc::clone(&reason2);
    let s2 = PostgresAdapter
        .connect(
            &params(),
            Box::new(move |why| *r2.lock().expect("lock") = Some(why)),
        )
        .await
        .expect("connect");
    s2.close().await;
    assert_eq!(*reason2.lock().expect("lock"), Some(None));
}
