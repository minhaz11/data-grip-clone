//! Result cursors against the disposable server (`scripts/test-pg.sh up`).

use std::sync::Arc;
use std::time::{Duration, Instant};

use quarry_db_core::{
    ConnectParams, DatabaseAdapter, ExecOptions, Session, StatementOutcome, TlsMode,
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
        application_name: "quarry-it-cursor".into(),
        options: Default::default(),
    }
}

async fn session() -> Arc<dyn Session> {
    PostgresAdapter
        .connect(&params(), Box::new(|_| {}))
        .await
        .expect("connect")
}

struct Rows {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    total: u64,
    cursor: Option<String>,
}

async fn query(s: &Arc<dyn Session>, sql: &str) -> Rows {
    match s.execute(sql, &ExecOptions::default()).await.expect(sql) {
        StatementOutcome::Rows {
            columns,
            rows,
            total_rows,
            cursor,
            ..
        } => Rows {
            columns: columns.into_iter().map(|c| c.name).collect(),
            rows,
            total: total_rows,
            cursor,
        },
        other => panic!("{sql}: expected rows, got {other:?}"),
    }
}

fn first(rows: &[Vec<Option<String>>]) -> Option<&str> {
    rows.first()
        .and_then(|r| r.first())
        .and_then(|c| c.as_deref())
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn million_rows_count_exactly_and_page_anywhere() {
    let s = session().await;
    let started = Instant::now();
    let r = query(
        &s,
        "select g, md5(g::text) as h from generate_series(1, 1000000) g",
    )
    .await;
    let first_page = started.elapsed();
    let cursor = r.cursor.expect("cursor for a query");
    assert_eq!((r.total, r.rows.len()), (1_000_000, 500));
    assert_eq!(r.columns, ["g", "h"]);
    assert_eq!(first(&r.rows), Some("1"));

    let opts = ExecOptions::default();
    let at = Instant::now();
    let last = s
        .fetch(&cursor, 999_500, 500, &opts)
        .await
        .expect("last page");
    let far_page = at.elapsed();
    assert_eq!(last.len(), 500);
    assert_eq!(first(&last), Some("999501"));
    assert_eq!(last[499][0].as_deref(), Some("1000000"));

    let middle = s.fetch(&cursor, 500_000, 3, &opts).await.expect("middle");
    assert_eq!(
        middle
            .iter()
            .map(|r| r[0].clone().unwrap_or_default())
            .collect::<Vec<_>>(),
        ["500001", "500002", "500003"]
    );
    assert!(
        s.fetch(&cursor, 1_000_000, 500, &opts)
            .await
            .expect("past end")
            .is_empty()
    );

    eprintln!("1M rows: first page after {first_page:?}, far page in {far_page:?}");
    assert!(
        far_page < Duration::from_millis(250),
        "random access page took {far_page:?}"
    );
    s.close_cursor(&cursor).await.expect("close");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn only_own_cursors_are_accepted_and_closed_ones_are_gone() {
    let s = session().await;
    let r = query(&s, "select 1").await;
    let cursor = r.cursor.expect("cursor");
    let opts = ExecOptions::default();
    for forged in [
        "pg_cursor; drop table shop.customers",
        "quarry_cursor_999999",
        "",
    ] {
        let e = s.fetch(forged, 0, 10, &opts).await.expect_err(forged);
        assert!(e.message.contains("no longer available"), "{e:?}");
    }
    s.close_cursor(&cursor).await.expect("close");
    s.close_cursor(&cursor).await.expect("close twice is fine");
    assert!(s.fetch(&cursor, 0, 1, &opts).await.is_err());
    // The forged name never reached the server as SQL.
    let still = query(&s, "select count(*) from shop.customers").await;
    assert_eq!(first(&still.rows), Some("50"));
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn empty_results_keep_columns() {
    let s = session().await;
    let r = query(&s, "select id, email from shop.customers where false").await;
    assert_eq!(
        (r.columns.as_slice(), r.total, r.rows.len()),
        (["id".to_owned(), "email".to_owned()].as_slice(), 0, 0)
    );
    assert!(r.cursor.is_some());
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn data_modifying_cte_falls_back_and_runs_exactly_once() {
    let s = session().await;
    s.execute("create temp table it_once (v int)", &ExecOptions::default())
        .await
        .expect("ddl");
    let r = query(
        &s,
        "with ins as (insert into it_once values (7) returning v) select v from ins",
    )
    .await;
    assert_eq!(first(&r.rows), Some("7"));
    assert!(
        r.cursor.is_none(),
        "DECLARE rejects data-modifying WITH; ran directly"
    );
    let count = query(&s, "select count(*) from it_once").await;
    assert_eq!(first(&count.rows), Some("1"), "the insert ran exactly once");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn runtime_errors_are_reported_not_retried() {
    let s = session().await;
    let e = s
        .execute("select 1 / 0", &ExecOptions::default())
        .await
        .expect_err("div by zero");
    assert_eq!(e.sqlstate.as_deref(), Some("22012"));
    // Analysis errors fall back to a direct run, so positions refer to the user's text.
    let sql = "select nope from shop.customers";
    let e = s
        .execute(sql, &ExecOptions::default())
        .await
        .expect_err("bad column");
    assert_eq!(e.position, Some(8), "{e:?}");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn cursor_dropped_by_rollback_reads_as_gone() {
    let s = session().await;
    let opts = ExecOptions::default();
    s.execute("begin", &opts).await.expect("begin");
    let r = query(&s, "select g from generate_series(1, 10) g").await;
    s.execute("rollback", &opts).await.expect("rollback");
    let e = s
        .fetch(r.cursor.as_deref().expect("cursor"), 0, 5, &opts)
        .await
        .expect_err("dropped");
    assert!(e.message.contains("no longer available"), "{e:?}");
    assert_eq!(e.hint.as_deref(), Some("Run the query again."));
}
