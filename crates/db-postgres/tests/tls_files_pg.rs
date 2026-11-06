//! TLS with files from the disposable server's test CA (`scripts/test-pg.sh up`): a custom CA for
//! verification and a client certificate for the role `quarry_cert` (which may only log in with
//! its certificate).

use std::path::PathBuf;
use std::time::Duration;

use quarry_db_core::{
    ConnectErrorKind as Kind, ConnectOptions, ConnectParams, DatabaseAdapter, TlsFiles, TlsMode,
};
use quarry_db_postgres::PostgresAdapter;
use quarry_secrets::SecretString;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/test-pg")
}

fn params(tls: TlsMode, files: TlsFiles) -> ConnectParams {
    let password = std::fs::read_to_string(dir().join("password"))
        .unwrap_or_else(|e| panic!("{e} (run scripts/test-pg.sh up)"))
        .trim()
        .to_owned();
    ConnectParams {
        host: "localhost".into(),
        port: 55432,
        database: "quarry_test".into(),
        username: "quarry".into(),
        password: Some(SecretString::new(password)),
        tls,
        connect_timeout: Duration::from_secs(5),
        read_only: false,
        application_name: "quarry-it-tls".into(),
        options: ConnectOptions {
            tls_files: files,
            ..Default::default()
        },
    }
}

fn ca(name: &str) -> TlsFiles {
    TlsFiles {
        ca: Some(dir().join(name)),
        ..Default::default()
    }
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn verify_full_succeeds_with_the_servers_ca_file() {
    for host in ["localhost", "127.0.0.1"] {
        let info = PostgresAdapter
            .test(&ConnectParams {
                host: host.into(),
                ..params(TlsMode::VerifyFull, ca("ca.crt"))
            })
            .await
            .unwrap_or_else(|e| panic!("{host}: {e:?}"));
        assert!(info.tls, "{host}");
    }
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn a_wrong_ca_file_is_refused_also_with_require() {
    for mode in [TlsMode::VerifyCa, TlsMode::VerifyFull, TlsMode::Require] {
        let err = PostgresAdapter
            .test(&params(mode, ca("tls/other-ca.crt")))
            .await
            .expect_err("untrusted");
        assert_eq!(err.kind, Kind::Tls, "{mode:?}: {err:?}");
    }
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn a_client_certificate_logs_in_without_a_password() {
    let files = TlsFiles {
        ca: Some(dir().join("ca.crt")),
        cert: Some(dir().join("tls/client.crt")),
        key: Some(dir().join("tls/client.key")),
    };
    let info = PostgresAdapter
        .test(&ConnectParams {
            username: "quarry_cert".into(),
            password: None,
            ..params(TlsMode::VerifyFull, files)
        })
        .await
        .expect("cert login");
    assert_eq!(info.user, "quarry_cert");
    assert!(info.tls);

    // Without the certificate the same role cannot log in.
    let err = PostgresAdapter
        .test(&ConnectParams {
            username: "quarry_cert".into(),
            password: None,
            ..params(TlsMode::VerifyFull, ca("ca.crt"))
        })
        .await
        .expect_err("no cert");
    assert!(
        matches!(err.kind, Kind::Auth | Kind::PasswordRequired),
        "{err:?}"
    );
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn unreadable_tls_files_name_the_file() {
    let err = PostgresAdapter
        .test(&params(TlsMode::VerifyFull, ca("tls/missing.pem")))
        .await
        .expect_err("missing");
    assert_eq!(err.kind, Kind::Tls);
    assert!(err.message.contains("missing.pem"), "{err:?}");
    assert!(err.hint.contains("TLS tab"), "{err:?}");

    // A certificate where the key should be.
    let err = PostgresAdapter
        .test(&params(
            TlsMode::Require,
            TlsFiles {
                ca: None,
                cert: Some(dir().join("tls/client.crt")),
                key: Some(dir().join("tls/client.crt")),
            },
        ))
        .await
        .expect_err("not a key");
    assert_eq!(err.kind, Kind::Tls);
    assert!(err.message.contains("private key"), "{err:?}");
}
