//! Transaction mode, state tracking, console sessions and the read-only guard against the
//! disposable server (`scripts/test-pg.sh up`).

use std::sync::Arc;
use std::time::{Duration, Instant};

use quarry_db_core::{
    ConnectParams, DatabaseAdapter, ExecOptions, Isolation, Session, StatementOutcome, TlsMode,
    TxMode, TxSettings, TxStatus,
};
use quarry_db_postgres::PostgresAdapter;
use quarry_secrets::SecretString;

fn params() -> ConnectParams {
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
        port: 55432,
        database: "quarry_test".into(),
        username: "quarry".into(),
        password: Some(SecretString::new(password)),
        tls: TlsMode::Disable,
        connect_timeout: Duration::from_secs(5),
        read_only: false,
        application_name: "quarry-it-tx".into(),
    }
}

async fn session_with(p: ConnectParams) -> Arc<dyn Session> {
    PostgresAdapter
        .connect(&p, Box::new(|_| {}))
        .await
        .expect("connect")
}

async fn session() -> Arc<dyn Session> {
    session_with(params()).await
}

const MANUAL: TxSettings = TxSettings {
    mode: TxMode::Manual,
    isolation: Isolation::ReadCommitted,
};

async fn run(s: &Arc<dyn Session>, sql: &str) {
    s.execute(sql, &ExecOptions::default())
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
}

async fn count(s: &Arc<dyn Session>, table: &str) -> String {
    match s
        .execute(
            &format!("select count(*)::text from {table}"),
            &ExecOptions::default(),
        )
        .await
        .expect("count")
    {
        StatementOutcome::Rows { rows, .. } => rows[0][0].clone().expect("value"),
        other => panic!("{other:?}"),
    }
}

/// A fresh, empty table owned by one test.
async fn table(s: &Arc<dyn Session>, name: &str) -> String {
    let t = format!("public.it_tx_{name}");
    run(s, &format!("drop table if exists {t}")).await;
    run(s, &format!("create table {t} (id int primary key)")).await;
    t
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn manual_mode_keeps_changes_private_until_commit() {
    let (a, b) = (session().await, session().await);
    let t = table(&b, "manual_commit").await;
    a.set_tx_settings(MANUAL);
    assert_eq!(a.tx_status(), TxStatus::Idle);

    run(&a, &format!("insert into {t} values (1)")).await;
    assert_eq!(
        a.tx_status(),
        TxStatus::Active,
        "the insert opened a transaction"
    );
    assert_eq!(count(&a, &t).await, "1");
    assert_eq!(
        count(&b, &t).await,
        "0",
        "not visible to another session yet"
    );

    assert_eq!(a.commit().await.expect("commit"), TxStatus::Idle);
    assert_eq!(count(&b, &t).await, "1");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn rollback_discards_and_a_failed_transaction_recovers() {
    let s = session().await;
    let t = table(&s, "rollback").await;
    s.set_tx_settings(MANUAL);

    run(&s, &format!("insert into {t} values (1)")).await;
    assert_eq!(s.rollback().await.expect("rollback"), TxStatus::Idle);
    assert_eq!(count(&s, &t).await, "0");
    s.rollback()
        .await
        .expect("rollback without a transaction is harmless");

    run(&s, &format!("insert into {t} values (2)")).await;
    let dup = s
        .execute(
            &format!("insert into {t} values (2)"),
            &ExecOptions::default(),
        )
        .await
        .expect_err("duplicate key");
    assert_eq!(dup.sqlstate.as_deref(), Some("23505"));
    assert_eq!(s.tx_status(), TxStatus::Failed);
    let ignored = s
        .execute("select 1", &ExecOptions::default())
        .await
        .expect_err("aborted transaction");
    assert_eq!(ignored.sqlstate.as_deref(), Some("25P02"));
    assert_eq!(s.tx_status(), TxStatus::Failed);

    let committed = s
        .commit()
        .await
        .expect_err("commit of a failed transaction");
    assert!(
        committed.message.contains("rolled it back"),
        "{committed:?}"
    );
    assert_eq!(s.tx_status(), TxStatus::Idle);
    assert_eq!(count(&s, &t).await, "0");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn auto_mode_follows_explicit_blocks() {
    let s = session().await;
    let t = table(&s, "explicit").await;
    run(&s, &format!("insert into {t} values (1)")).await;
    assert_eq!(
        s.tx_status(),
        TxStatus::Idle,
        "auto mode commits each statement"
    );

    run(&s, "begin").await;
    assert_eq!(s.tx_status(), TxStatus::Active);
    run(&s, &format!("insert into {t} values (2)")).await;
    run(&s, "savepoint sp").await;
    run(&s, &format!("insert into {t} values (3)")).await;
    run(&s, "rollback to savepoint sp").await;
    assert_eq!(s.tx_status(), TxStatus::Active);
    run(&s, "commit").await;
    assert_eq!(s.tx_status(), TxStatus::Idle);
    assert_eq!(count(&s, &t).await, "2");

    // Tracking the state must not count as the transaction's first query.
    run(&s, "begin").await;
    run(&s, "set transaction isolation level serializable").await;
    run(&s, "commit").await;

    // A procedure-like block that commits on its own is followed too.
    run(&s, "begin").await;
    run(&s, "do $$ begin perform 1; end $$").await;
    assert_eq!(s.tx_status(), TxStatus::Active);
    run(&s, "end").await;
    assert_eq!(s.tx_status(), TxStatus::Idle);
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn manual_mode_uses_the_isolation_level_and_skips_statements_that_need_no_block() {
    let s = session().await;
    let t = table(&s, "isolation").await;
    s.set_tx_settings(TxSettings {
        mode: TxMode::Manual,
        isolation: Isolation::Serializable,
    });
    match s
        .execute(
            "select current_setting('transaction_isolation')",
            &ExecOptions::default(),
        )
        .await
        .expect("isolation")
    {
        StatementOutcome::Rows { rows, .. } => {
            assert_eq!(rows[0][0].as_deref(), Some("serializable"));
        }
        other => panic!("{other:?}"),
    }
    s.commit().await.expect("commit");
    // VACUUM refuses to run inside a block; Manual mode must not open one for it.
    run(&s, &format!("vacuum {t}")).await;
    assert_eq!(s.tx_status(), TxStatus::Idle);
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn results_page_inside_and_after_a_manual_transaction() {
    let s = session().await;
    s.set_tx_settings(MANUAL);
    let cursor = match s
        .execute(
            "select g from generate_series(1, 2000) g",
            &ExecOptions::default(),
        )
        .await
        .expect("query")
    {
        StatementOutcome::Rows {
            cursor, total_rows, ..
        } => {
            assert_eq!(total_rows, 2000);
            cursor.expect("cursor-backed")
        }
        other => panic!("{other:?}"),
    };
    assert_eq!(s.tx_status(), TxStatus::Active);
    let opts = ExecOptions::default();
    let page = s.fetch(&cursor, 1500, 2, &opts).await.expect("page inside");
    assert_eq!(page[0][0].as_deref(), Some("1501"));
    s.commit().await.expect("commit");
    let page = s
        .fetch(&cursor, 1998, 5, &opts)
        .await
        .expect("page after commit");
    assert_eq!(page.len(), 2, "WITH HOLD cursors survive the commit");

    // A rollback drops cursors declared in that transaction; paging reports it, never hangs.
    let rolled = match s
        .execute("select 1", &ExecOptions::default())
        .await
        .expect("query")
    {
        StatementOutcome::Rows { cursor, .. } => cursor.expect("cursor"),
        other => panic!("{other:?}"),
    };
    s.rollback().await.expect("rollback");
    s.fetch(&rolled, 0, 1, &opts)
        .await
        .expect_err("cursor rolled back");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn forked_sessions_run_concurrently_with_their_own_transaction() {
    let a = session().await;
    let b = a.fork(Box::new(|_| {})).await.expect("fork");
    let t = table(&a, "fork").await;
    b.set_tx_settings(MANUAL);
    run(&b, &format!("insert into {t} values (1)")).await;
    assert_eq!(
        (a.tx_status(), b.tx_status()),
        (TxStatus::Idle, TxStatus::Active)
    );
    assert_eq!(count(&a, &t).await, "0");

    let started = Instant::now();
    let opts = ExecOptions::default();
    let (slow, fast) = tokio::join!(a.execute("select pg_sleep(1.5)", &opts), async {
        let r = b.execute("select 1", &opts).await;
        (r, started.elapsed())
    });
    slow.expect("sleep");
    fast.0.expect("select on the fork");
    assert!(
        fast.1 < Duration::from_millis(1000),
        "fork waited: {:?}",
        fast.1
    );
    b.rollback().await.expect("rollback");
    b.close().await;
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn schema_selection_resolves_unqualified_names() {
    let s = session().await;
    run(&s, "drop schema if exists it_tx_schema cascade").await;
    run(&s, "create schema it_tx_schema").await;
    run(&s, "create table it_tx_schema.only_here (id int)").await;
    let opts = ExecOptions::default();
    s.execute("select * from only_here", &opts)
        .await
        .expect_err("not on the default path");

    s.set_schema(Some("it_tx_schema")).await.expect("set");
    s.execute("select * from only_here", &opts)
        .await
        .expect("found");
    // The default path follows, so public objects still resolve.
    s.execute("select count(*) from pg_class", &opts)
        .await
        .expect("catalog");

    s.set_schema(None).await.expect("reset");
    s.execute("select * from only_here", &opts)
        .await
        .expect_err("back to the default path");

    // Names are quoted by the server: odd names are exact, never SQL.
    s.set_schema(Some("x'; drop table it_tx_schema.only_here; --"))
        .await
        .expect("odd name is just a name");
    s.set_schema(None).await.expect("reset");
    run(&s, "select * from it_tx_schema.only_here").await;
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn read_only_sources_cannot_be_switched_to_read_write() {
    let writer = session().await;
    let t = table(&writer, "read_only").await;
    run(
        &writer,
        "create or replace function public.it_tx_write() returns int
           language sql as $$ insert into public.it_tx_read_only values (42) returning id $$",
    )
    .await;
    let ro = session_with(ConnectParams {
        read_only: true,
        ..params()
    })
    .await;
    let opts = ExecOptions::default();
    let write = |s: Arc<dyn Session>| async move {
        s.execute("select public.it_tx_write()", &ExecOptions::default())
            .await
    };

    // The session default switched off by SET or by set_config() is restored before the next
    // statement, so the writing function still fails.
    run(&ro, "set default_transaction_read_only = off").await;
    let e = write(ro.clone()).await.expect_err("write after SET");
    assert_eq!(e.sqlstate.as_deref(), Some("25006"), "{e:?}");
    run(
        &ro,
        "select set_config('default_transaction_read_only', 'off', false)",
    )
    .await;
    let e = write(ro.clone()).await.expect_err("write after set_config");
    assert_eq!(e.sqlstate.as_deref(), Some("25006"), "{e:?}");

    // A transaction made read-write is rolled back at once.
    let e = ro
        .execute("begin read write", &opts)
        .await
        .expect_err("begin read write");
    assert_eq!(e.sqlstate.as_deref(), Some("25006"), "{e:?}");
    assert_eq!(ro.tx_status(), TxStatus::Idle);
    run(&ro, "begin").await;
    let e = ro
        .execute("set transaction read write", &opts)
        .await
        .expect_err("set transaction read write");
    assert_eq!(e.sqlstate.as_deref(), Some("25006"), "{e:?}");
    assert_eq!(ro.tx_status(), TxStatus::Idle);
    let e = write(ro.clone()).await.expect_err("still read-only");
    assert_eq!(e.sqlstate.as_deref(), Some("25006"), "{e:?}");

    // Manual mode opens its transactions read-only too.
    ro.set_tx_settings(MANUAL);
    let e = write(ro.clone()).await.expect_err("write in manual mode");
    assert_eq!(e.sqlstate.as_deref(), Some("25006"), "{e:?}");
    ro.rollback().await.expect("rollback");

    assert_eq!(count(&writer, &t).await, "0", "nothing was written");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn abort_drops_the_connection_while_a_statement_runs() {
    let s = session().await;
    let running = {
        let s = Arc::clone(&s);
        tokio::spawn(async move {
            s.execute("select pg_sleep(30)", &ExecOptions::default())
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = Instant::now();
    s.abort();
    let result = tokio::time::timeout(Duration::from_secs(3), running)
        .await
        .expect("the running statement ended")
        .expect("task");
    let e = result.expect_err("connection dropped");
    assert!(e.connection_lost, "{e:?}");
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(s.is_closed());
}
