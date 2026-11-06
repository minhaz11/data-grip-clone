//! Editor support against the disposable server (`scripts/test-pg.sh up` and `seed`): bound
//! parameters, notices, the statement timeout and the function catalog.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use quarry_db_core::{
    Cell, ConnectParams, DatabaseAdapter, ExecOptions, MetadataRequest, Notice, Session,
    StatementOutcome, TlsMode,
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
        application_name: "quarry-it-editor".into(),
        options: Default::default(),
    }
}

async fn session() -> Arc<dyn Session> {
    PostgresAdapter
        .connect(&params(), Box::new(|_| {}))
        .await
        .expect("connect")
}

fn s(v: &str) -> Cell {
    Some(v.into())
}

fn first_rows(o: StatementOutcome) -> Vec<Vec<Cell>> {
    match o {
        StatementOutcome::Rows { rows, .. } => rows,
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn parameters_bind_with_inferred_types_and_stay_values() {
    let s_ = session().await;
    let opts = ExecOptions::default();
    // Types come from the statement: int8 comparison, numeric arithmetic, timestamptz, NULL.
    let rows = first_rows(
        s_.execute_params(
            "select id, email from shop.customers where id = $1",
            &[s("1")],
            &opts,
        )
        .await
        .expect("int param"),
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0][0].as_deref(), Some("1"));
    let rows = first_rows(
        s_.execute_params(
            "select $1::numeric * 2, $2::timestamptz < now(), $3::text is null",
            &[s("1.25"), s("2000-01-01 00:00:00+00"), None],
            &opts,
        )
        .await
        .expect("typed params"),
    );
    assert_eq!(
        rows[0],
        vec![s("2.50"), s("t"), s("t")],
        "values parsed for their types"
    );
    // An injection attempt is just a string that matches nothing.
    let rows = first_rows(
        s_.execute_params(
            "select count(*) from shop.customers where email = $1",
            &[s("x' or '1'='1")],
            &opts,
        )
        .await
        .expect("injection"),
    );
    assert_eq!(rows[0][0].as_deref(), Some("0"));
    // A value the type cannot parse is a clear error, not a different statement.
    let e = s_
        .execute_params(
            "select * from shop.customers where id = $1",
            &[s("1; drop table shop.customers")],
            &opts,
        )
        .await
        .expect_err("not an integer");
    assert_eq!(e.sqlstate.as_deref(), Some("22P02"), "{e:?}");
    // Statements outside a cursor bind too and report their row count.
    s_.execute("create temp table it_params (v text)", &opts)
        .await
        .expect("temp");
    let done = s_
        .execute_params(
            "insert into it_params values ($1), ($2)",
            &[s("a"), None],
            &opts,
        )
        .await
        .expect("insert");
    assert_eq!(done, StatementOutcome::Command { rows_affected: 2 });
    let rows = first_rows(
        s_.execute(
            "select count(*) filter (where v is null) from it_params",
            &opts,
        )
        .await
        .expect("count"),
    );
    assert_eq!(rows[0][0].as_deref(), Some("1"));
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn notices_arrive_in_order_while_the_statement_runs() {
    let s_ = session().await;
    let seen: Arc<Mutex<Vec<Notice>>> = Arc::default();
    {
        let seen = Arc::clone(&seen);
        s_.set_notice_sink(Some(Arc::new(move |n| {
            seen.lock().expect("lock").push(n);
        })));
    }
    s_.execute(
        "do $$ begin raise notice 'first %', 1; raise warning 'second' using hint = 'h'; raise notice 'third'; end $$",
        &ExecOptions::default(),
    )
    .await
    .expect("do");
    let got: Vec<(String, String)> = seen
        .lock()
        .expect("lock")
        .iter()
        .map(|n| (n.severity.clone(), n.message.clone()))
        .collect();
    assert_eq!(
        got,
        [
            ("NOTICE".into(), "first 1".into()),
            ("WARNING".into(), "second".into()),
            ("NOTICE".into(), "third".into()),
        ]
    );
    assert_eq!(
        seen.lock().expect("lock")[1].hint.as_deref(),
        Some("h"),
        "details come along"
    );
    // Without a sink, notices are dropped.
    s_.set_notice_sink(None);
    s_.execute(
        "do $$ begin raise notice 'nobody'; end $$",
        &ExecOptions::default(),
    )
    .await
    .expect("do");
    assert_eq!(seen.lock().expect("lock").len(), 3);
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn statement_timeout_cancels_long_statements() {
    let s_ = session().await;
    s_.set_statement_timeout(200).await.expect("timeout");
    let e = s_
        .execute("select pg_sleep(5)", &ExecOptions::default())
        .await
        .expect_err("timed out");
    assert_eq!(e.sqlstate.as_deref(), Some("57014"), "{e:?}");
    assert!(
        e.message.contains("statement timeout") && !e.cancelled,
        "the message says why: {e:?}"
    );
    // Also outside a cursor (no result set).
    let e = s_
        .execute(
            "do $$ begin perform pg_sleep(5); end $$",
            &ExecOptions::default(),
        )
        .await
        .expect_err("timed out");
    assert_eq!(e.sqlstate.as_deref(), Some("57014"), "{e:?}");
    // 0 removes the limit again.
    s_.set_statement_timeout(0).await.expect("off");
    s_.execute("select pg_sleep(0.3)", &ExecOptions::default())
        .await
        .expect("no limit");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn function_catalog_lists_user_and_useful_builtin_functions() {
    let s_ = session().await;
    s_.apply_schema(&[
        "drop schema if exists it_funcs cascade".into(),
        "create schema it_funcs".into(),
        "create function it_funcs.order_total(order_id bigint) returns numeric language sql as 'select 0::numeric'".into(),
    ])
    .await
    .expect("fixture");
    let nodes = s_
        .metadata(&MetadataRequest::Functions)
        .await
        .expect("functions");
    let user = nodes
        .iter()
        .find(|n| n.key == "it_funcs\u{1f}order_total(order_id bigint)")
        .expect("user function listed");
    assert_eq!(user.name, "order_total");
    assert_eq!(user.detail.as_deref(), Some("(order_id bigint) → numeric"));
    let names: Vec<&str> = nodes.iter().map(|n| n.name.as_str()).collect();
    for builtin in ["now", "count", "lower", "jsonb_build_object"] {
        assert!(names.contains(&builtin), "{builtin} is offered");
    }
    let count = nodes.iter().find(|n| n.name == "count").expect("count");
    assert!(count.flags.contains(&"aggregate".to_owned()));
    for internal in ["int4in", "int4pl", "textout", "int8"] {
        assert!(
            !names.contains(&internal),
            "{internal} (type I/O, operator or cast) is left out"
        );
    }
    // User functions come before pg_catalog ones.
    let first_builtin = nodes
        .iter()
        .position(|n| n.key.starts_with("pg_catalog\u{1f}"))
        .expect("builtins");
    let user_at = nodes
        .iter()
        .position(|n| n.key.starts_with("it_funcs\u{1f}"))
        .expect("user");
    assert!(user_at < first_builtin);
}
