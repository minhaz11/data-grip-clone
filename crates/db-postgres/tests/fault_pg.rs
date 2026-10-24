//! Fault injection (Phase 7): a TCP proxy between the adapter and the disposable server
//! (`scripts/test-pg.sh up`) drops, stalls or refuses connections. Every scenario must end in a
//! clear state the UI can act on, without hanging and without losing data:
//!
//! - lost (`connection_lost`): the UI marks the data source disconnected and offers Reconnect;
//! - error (a server error on a live session): shown in Output, the session stays usable;
//! - connect failures carry a kind (refused, timeout) that the connect dialog explains.
//!
//! The SSH tunnel drop is covered in `ssh_pg.rs` (`losing_the_ssh_connection_marks_the_session_lost`).

mod support;

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use quarry_db_core::{
    ConnectErrorKind, ConnectParams, DatabaseAdapter, ExecOptions, Session, StatementOutcome,
    TlsMode,
};
use quarry_db_postgres::PostgresAdapter;
use quarry_io::{Format, StreamError, WriteOptions, export_to_file, partial_path};
use quarry_secrets::SecretString;
use support::fault_proxy::FaultProxy;

const SERVER: &str = "127.0.0.1:55432";

fn params(port: u16) -> ConnectParams {
    let pw_file = format!(
        "{}/../../target/test-pg/password",
        env!("CARGO_MANIFEST_DIR")
    );
    let password = std::fs::read_to_string(&pw_file)
        .unwrap_or_else(|e| panic!("{pw_file}: {e} (run scripts/test-pg.sh up)"))
        .trim()
        .to_owned();
    ConnectParams {
        host: "127.0.0.1".into(),
        port,
        database: "quarry_test".into(),
        username: "quarry".into(),
        password: Some(SecretString::new(password)),
        tls: TlsMode::Disable,
        connect_timeout: Duration::from_secs(2),
        read_only: false,
        application_name: "quarry-it-faults".into(),
        options: Default::default(),
    }
}

async fn proxy() -> FaultProxy {
    FaultProxy::start(SERVER.parse::<SocketAddr>().expect("server address")).await
}

async fn connect(port: u16) -> Arc<dyn Session> {
    PostgresAdapter
        .connect(&params(port), Box::new(|_| {}))
        .await
        .expect("connect through the proxy")
}

/// Fails the test instead of hanging when a fault leaves a call waiting forever.
async fn within<T>(limit: Duration, what: &str, f: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(limit, f)
        .await
        .unwrap_or_else(|_| panic!("{what} hung for more than {limit:?}"))
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn a_drop_mid_query_marks_the_session_lost_and_reconnecting_works() {
    let p = proxy().await;
    let s = connect(p.port()).await;
    let running = {
        let s = Arc::clone(&s);
        tokio::spawn(async move {
            s.execute("select pg_sleep(30)", &ExecOptions::default())
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    p.drop_connections();
    let err = within(Duration::from_secs(5), "the dropped query", running)
        .await
        .expect("task")
        .expect_err("the query cannot finish");
    assert!(err.connection_lost, "{err:?}");
    assert!(s.is_closed());
    // A fresh connection works as soon as the network is back.
    let again = connect(p.port()).await;
    let out = again
        .execute("select 1", &ExecOptions::default())
        .await
        .expect("query after reconnect");
    assert!(matches!(out, StatementOutcome::Rows { .. }));
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn a_drop_between_pages_fails_the_next_page_as_lost() {
    let p = proxy().await;
    let s = connect(p.port()).await;
    let cursor = match s
        .execute(
            "select g, repeat('x', 100) from generate_series(1, 50000) g",
            &ExecOptions::default(),
        )
        .await
        .expect("query")
    {
        StatementOutcome::Rows { cursor, rows, .. } => {
            assert_eq!(rows.len(), 500, "first page arrived");
            cursor.expect("cursor")
        }
        other => panic!("{other:?}"),
    };
    p.drop_connections();
    let err = within(
        Duration::from_secs(5),
        "the page fetch",
        s.fetch(&cursor, 500, 500, &ExecOptions::default()),
    )
    .await
    .expect_err("no page after the drop");
    assert!(err.connection_lost, "{err:?}");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn a_drop_during_export_reports_lost_and_leaves_no_file() {
    let p = proxy().await;
    let s = connect(p.port()).await;
    let (columns, cursor) = match s
        .execute(
            "select g, md5(g::text) from generate_series(1, 2000000) g",
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
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("out.csv");
    let cut = Arc::new(AtomicBool::new(false));
    let progress = {
        let cut = Arc::clone(&cut);
        let p = &p;
        move |rows: u64| {
            if rows >= 20_000 && !cut.swap(true, std::sync::atomic::Ordering::SeqCst) {
                p.drop_connections();
            }
        }
    };
    let never = AtomicBool::new(false);
    let result = within(
        Duration::from_secs(20),
        "the export",
        export_to_file(
            s.as_ref(),
            &cursor,
            &columns,
            Format::Csv,
            &WriteOptions::default(),
            &path,
            &never,
            &progress,
        ),
    )
    .await;
    match result {
        Err(StreamError::Db(e)) => assert!(e.connection_lost, "{e:?}"),
        other => panic!("expected a lost connection, got {other:?}"),
    }
    assert!(!path.exists(), "no half-written export");
    assert!(
        !partial_path(&path, Format::Csv).exists(),
        "partial file removed"
    );
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn a_server_restart_is_refused_then_reconnects() {
    let p = proxy().await;
    let s = connect(p.port()).await;
    // The server goes away: open sessions drop, new connections are refused.
    p.refuse();
    p.drop_connections();
    let err = within(
        Duration::from_secs(5),
        "the query on a dead session",
        s.execute("select 1", &ExecOptions::default()),
    )
    .await
    .expect_err("server is gone");
    assert!(err.connection_lost, "{err:?}");
    let refused = PostgresAdapter
        .connect(&params(p.port()), Box::new(|_| {}))
        .await
        .err()
        .expect("refused while down");
    assert_eq!(refused.kind, ConnectErrorKind::Refused);
    // Back up: connecting works again.
    p.resume().await;
    let again = connect(p.port()).await;
    again
        .execute("select 1", &ExecOptions::default())
        .await
        .expect("query after restart");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn a_silent_network_never_hangs_connect_or_a_dropped_session() {
    let p = proxy().await;
    // Connecting into silence ends at the connect timeout.
    p.stall(true);
    let started = Instant::now();
    let err = within(
        Duration::from_secs(10),
        "connect",
        PostgresAdapter.connect(&params(p.port()), Box::new(|_| {})),
    )
    .await
    .err()
    .expect("no answer");
    assert_eq!(err.kind, ConnectErrorKind::Timeout);
    assert!(started.elapsed() < Duration::from_secs(5));
    p.stall(false);

    // A session whose network goes silent mid-query: Stop's second stage drops the connection,
    // and the running call returns at once.
    let s = connect(p.port()).await;
    p.stall(true);
    let running = {
        let s = Arc::clone(&s);
        tokio::spawn(async move { s.execute("select 1", &ExecOptions::default()).await })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!running.is_finished(), "the answer cannot arrive");
    s.abort();
    let err = within(Duration::from_secs(5), "the aborted query", running)
        .await
        .expect("task")
        .expect_err("aborted");
    assert!(err.connection_lost, "{err:?}");
    p.stall(false);
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn permission_denied_mid_script_is_an_error_and_the_session_stays_usable() {
    let s = connect(55432).await;
    let setup = [
        "drop table if exists fault_secret",
        "create table fault_secret (id int)",
        "do $$ begin create role quarry_fault_limited nologin; exception when duplicate_object then null; end $$",
    ];
    for sql in setup {
        s.execute(sql, &ExecOptions::default()).await.expect(sql);
    }
    s.execute("set role quarry_fault_limited", &ExecOptions::default())
        .await
        .expect("set role");
    let err = s
        .execute("select * from fault_secret", &ExecOptions::default())
        .await
        .expect_err("no privilege");
    assert_eq!(err.sqlstate.as_deref(), Some("42501"), "{err:?}");
    assert!(!err.connection_lost);
    assert!(!s.is_closed());
    // The same session goes on working.
    s.execute("reset role", &ExecOptions::default())
        .await
        .expect("reset role");
    s.execute("select count(*) from fault_secret", &ExecOptions::default())
        .await
        .expect("allowed again");
    s.execute("drop table fault_secret", &ExecOptions::default())
        .await
        .expect("cleanup");
}
