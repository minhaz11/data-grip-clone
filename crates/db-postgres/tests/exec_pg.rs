//! Statement execution against the disposable server (`scripts/test-pg.sh up`).

use std::sync::Arc;
use std::time::{Duration, Instant};

use quarry_db_core::{
    ConnectParams, DatabaseAdapter, DbError, ExecOptions, Session, StatementOutcome, TlsMode,
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
        tls: TlsMode::Prefer,
        connect_timeout: Duration::from_secs(5),
        read_only: false,
        application_name: "quarry-it-exec".into(),
    }
}

async fn session_with(p: ConnectParams) -> Arc<dyn Session> {
    PostgresAdapter
        .connect(&p, Box::new(|_| {}))
        .await
        .expect("connect")
}

async fn run(s: &Arc<dyn Session>, sql: &str) -> Result<StatementOutcome, DbError> {
    s.execute(sql, &ExecOptions::default()).await
}

type Columns = Vec<(String, Option<String>)>;
type Rows = Vec<Vec<Option<String>>>;

fn rows(o: StatementOutcome) -> (Columns, Rows, u64, bool) {
    match o {
        StatementOutcome::Rows {
            columns,
            rows,
            total_rows,
            truncated,
        } => (
            columns.into_iter().map(|c| (c.name, c.type_name)).collect(),
            rows,
            total_rows,
            truncated,
        ),
        other => panic!("expected rows, got {other:?}"),
    }
}

/// The text the error position points at, for asserting positions land on the right token.
fn at_position(sql: &str, e: &DbError) -> String {
    let pos = e.position.unwrap_or_else(|| panic!("no position in {e:?}")) as usize;
    sql.chars().skip(pos - 1).take(8).collect()
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn select_returns_typed_columns_and_exact_text_values() {
    let s = session_with(params()).await;
    let (cols, data, total, truncated) = rows(
        run(&s, "select 1::int4 as a, 'x'::text as b, null::int as c, 12345678901234567890.123::numeric as big, '2026-01-02'::date as d")
            .await
            .expect("select"),
    );
    let types: Vec<(&str, Option<&str>)> = cols
        .iter()
        .map(|(n, t)| (n.as_str(), t.as_deref()))
        .collect();
    assert_eq!(
        types,
        [
            ("a", Some("int4")),
            ("b", Some("text")),
            ("c", Some("int4")),
            ("big", Some("numeric")),
            ("d", Some("date"))
        ]
    );
    assert_eq!(
        data,
        [[
            Some("1".into()),
            Some("x".into()),
            None,
            Some("12345678901234567890.123".into()),
            Some("2026-01-02".into())
        ]]
    );
    assert_eq!((total, truncated), (1, false));

    let (cols, data, total, _) = rows(
        run(&s, "select * from shop.customers where false")
            .await
            .expect("empty"),
    );
    assert!(
        cols.iter().any(|(n, _)| n == "email"),
        "columns still described for empty results"
    );
    assert!(data.is_empty());
    assert_eq!(total, 0);
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn large_results_are_capped_but_counted_and_long_cells_marked() {
    let s = session_with(params()).await;
    let opts = ExecOptions {
        max_rows: 500,
        max_cell_chars: 50,
    };
    match s
        .execute(
            "select g, repeat('x', 100) from generate_series(1, 2000) g",
            &opts,
        )
        .await
        .expect("big")
    {
        StatementOutcome::Rows {
            rows,
            total_rows,
            truncated,
            ..
        } => {
            assert_eq!((rows.len(), total_rows, truncated), (500, 2000, true));
            assert_eq!(rows[499][0].as_deref(), Some("500"));
            assert!(
                rows[0][1]
                    .as_deref()
                    .is_some_and(|c| c.ends_with("… [100 chars]"))
            );
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn dml_and_ddl_report_affected_rows() {
    let s = session_with(params()).await;
    assert_eq!(
        run(&s, "create temp table it_exec (id int, v text)")
            .await
            .expect("ddl"),
        StatementOutcome::Command { rows_affected: 0 }
    );
    assert_eq!(
        run(&s, "insert into it_exec values (1,'a'),(2,'b'),(3,'c')")
            .await
            .expect("insert"),
        StatementOutcome::Command { rows_affected: 3 }
    );
    assert_eq!(
        run(&s, "update it_exec set v = 'z' where id > 1")
            .await
            .expect("update"),
        StatementOutcome::Command { rows_affected: 2 }
    );
    let (_, data, _, _) = rows(
        run(&s, "delete from it_exec where id = 1 returning id")
            .await
            .expect("returning"),
    );
    assert_eq!(data, [[Some("1".into())]], "RETURNING yields a result set");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn errors_carry_sqlstate_and_point_at_the_offending_token() {
    let s = session_with(params()).await;
    let sql = "select id,\n  emial\nfrom shop.customers";
    let e = run(&s, sql).await.expect_err("bad column");
    assert_eq!(e.sqlstate.as_deref(), Some("42703"));
    assert!(at_position(sql, &e).starts_with("emial"), "{e:?}");

    let sql = "select * from shop.custmers";
    let e = run(&s, sql).await.expect_err("bad table");
    assert_eq!(e.sqlstate.as_deref(), Some("42P01"));
    assert!(at_position(sql, &e).starts_with("shop.cus"), "{e:?}");

    let sql = "selec 1";
    let e = run(&s, sql).await.expect_err("syntax");
    assert_eq!(e.sqlstate.as_deref(), Some("42601"));
    assert!(at_position(sql, &e).starts_with("selec"), "{e:?}");
    assert!(!e.cancelled && !e.connection_lost);

    // The session survives errors.
    let (_, data, _, _) = rows(run(&s, "select 'still alive'").await.expect("after error"));
    assert_eq!(data[0][0].as_deref(), Some("still alive"));
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn pg_sleep_cancels_within_one_second() {
    let s = session_with(params()).await;
    let runner = {
        let s = Arc::clone(&s);
        tokio::spawn(async move {
            let started = Instant::now();
            (
                s.execute("select pg_sleep(30)", &ExecOptions::default())
                    .await,
                started.elapsed(),
            )
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    let cancel_at = Instant::now();
    s.cancel().await.expect("cancel delivered");
    let (result, total) = runner.await.expect("join");
    let after_cancel = cancel_at.elapsed();

    let e = result.expect_err("cancelled");
    assert!(e.cancelled, "{e:?}");
    assert_eq!(e.sqlstate.as_deref(), Some("57014"));
    assert!(
        after_cancel < Duration::from_secs(1),
        "cancel took {after_cancel:?}"
    );
    assert!(total < Duration::from_secs(2), "statement ran {total:?}");

    // The same session keeps working after a cancel.
    let (_, data, _, _) = rows(run(&s, "select 42").await.expect("after cancel"));
    assert_eq!(data[0][0].as_deref(), Some("42"));
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn read_only_sessions_reject_writes_server_side() {
    let s = session_with(ConnectParams {
        read_only: true,
        ..params()
    })
    .await;
    let e = run(&s, "create table it_should_not_exist (x int)")
        .await
        .expect_err("read-only");
    assert_eq!(e.sqlstate.as_deref(), Some("25006"), "{e:?}");
    assert!(rows(run(&s, "select 1").await.expect("reads ok")).1.len() == 1);
}
