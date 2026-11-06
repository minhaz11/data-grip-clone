//! Server-side sort/filter against the disposable server (`scripts/test-pg.sh up`).

use std::sync::Arc;
use std::time::Duration;

use quarry_db_core::{
    ColumnInfo, ConnectParams, DatabaseAdapter, ExecOptions, Filter, FilterOp, Refinement, Session,
    SortKey, StatementOutcome, TlsMode,
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
        application_name: "quarry-it-refine".into(),
        options: Default::default(),
    }
}

async fn session() -> Arc<dyn Session> {
    PostgresAdapter
        .connect(&params(), Box::new(|_| {}))
        .await
        .expect("connect")
}

/// Runs `sql`, returning its columns (as the UI would keep them).
async fn columns_of(s: &Arc<dyn Session>, sql: &str) -> Vec<ColumnInfo> {
    match s.execute(sql, &ExecOptions::default()).await.expect(sql) {
        StatementOutcome::Rows {
            columns, cursor, ..
        } => {
            if let Some(c) = cursor {
                s.close_cursor(&c).await.expect("close");
            }
            columns
        }
        other => panic!("{other:?}"),
    }
}

struct Out {
    names: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    total: u64,
    cursor: Option<String>,
}

async fn refine(s: &Arc<dyn Session>, sql: &str, r: Refinement) -> Out {
    let cols = columns_of(s, sql).await;
    match s
        .refine(sql, &cols, &r, &ExecOptions::default())
        .await
        .expect("refine")
    {
        StatementOutcome::Rows {
            columns,
            rows,
            total_rows,
            cursor,
            ..
        } => Out {
            names: columns.into_iter().map(|c| c.name).collect(),
            rows,
            total: total_rows,
            cursor,
        },
        other => panic!("{other:?}"),
    }
}

fn f(column: usize, op: FilterOp, value: Option<&str>) -> Filter {
    Filter {
        column,
        op,
        value: value.map(str::to_owned),
    }
}
fn col0(o: &Out) -> Vec<String> {
    o.rows
        .iter()
        .map(|r| r[0].clone().unwrap_or_else(|| "NULL".into()))
        .collect()
}

const SERIES: &str = "select g, 'name ' || g as label, case when g % 5 = 0 then null else g * 10 end as maybe \
                      from generate_series(1, 1000) g";

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn sorts_numerically_and_filters_with_typed_values() {
    let s = session().await;
    let o = refine(
        &s,
        SERIES,
        Refinement {
            sort: vec![SortKey {
                column: 0,
                descending: true,
            }],
            filters: vec![],
        },
    )
    .await;
    assert_eq!(
        (o.total, o.rows[0][0].as_deref()),
        (1000, Some("1000")),
        "numeric, not text, ordering"
    );
    assert_eq!(
        o.names,
        ["g", "label", "maybe"],
        "original names, not c1…cn"
    );
    assert!(o.cursor.is_some());

    let o = refine(
        &s,
        SERIES,
        Refinement {
            sort: vec![],
            filters: vec![
                f(0, FilterOp::Ge, Some("995")),
                f(2, FilterOp::NotNull, None),
            ],
        },
    )
    .await;
    assert_eq!(col0(&o), ["996", "997", "998", "999"]);

    let o = refine(
        &s,
        SERIES,
        Refinement {
            sort: vec![SortKey {
                column: 2,
                descending: false,
            }],
            filters: vec![f(2, FilterOp::IsNull, None)],
        },
    )
    .await;
    assert_eq!(o.total, 200);

    // Filtered results are cursor-backed like any other: page deep into them.
    let o = refine(
        &s,
        SERIES,
        Refinement {
            sort: vec![SortKey {
                column: 0,
                descending: false,
            }],
            filters: vec![f(0, FilterOp::Gt, Some("100"))],
        },
    )
    .await;
    let page = s
        .fetch(
            o.cursor.as_deref().expect("cursor"),
            800,
            5,
            &ExecOptions::default(),
        )
        .await
        .expect("page");
    assert_eq!(
        page.iter()
            .map(|r| r[0].clone().unwrap_or_default())
            .collect::<Vec<_>>(),
        ["901", "902", "903", "904", "905"]
    );
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn text_matching_is_literal_case_insensitive_and_timestamps_compare_as_timestamps() {
    let s = session().await;
    let sql =
        "select * from (values ('50% off'), ('500 off'), ('a_b'), ('aXb'), ('Mixed Case')) v(t)";
    let o = refine(
        &s,
        sql,
        Refinement {
            sort: vec![],
            filters: vec![f(0, FilterOp::Contains, Some("0%"))],
        },
    )
    .await;
    assert_eq!(col0(&o), ["50% off"], "% is literal");
    let o = refine(
        &s,
        sql,
        Refinement {
            sort: vec![],
            filters: vec![f(0, FilterOp::Contains, Some("a_b"))],
        },
    )
    .await;
    assert_eq!(col0(&o), ["a_b"], "_ is literal");
    let o = refine(
        &s,
        sql,
        Refinement {
            sort: vec![],
            filters: vec![f(0, FilterOp::StartsWith, Some("mixed"))],
        },
    )
    .await;
    assert_eq!(col0(&o), ["Mixed Case"]);

    let ts = "select x::timestamptz as at from (values ('2026-01-01 10:00+00'), ('2026-03-01 10:00+00'), ('2025-12-31 23:00+00')) v(x)";
    let o = refine(
        &s,
        ts,
        Refinement {
            sort: vec![SortKey {
                column: 0,
                descending: false,
            }],
            filters: vec![f(0, FilterOp::Ge, Some("2026-01-01"))],
        },
    )
    .await;
    assert_eq!(o.total, 2);
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn duplicate_names_trailing_comments_and_ctes_work() {
    let s = session().await;
    let o = refine(
        &s,
        "select a.id, b.id from shop.customers a join shop.customers b on b.id = a.id + 1 -- pairs",
        Refinement {
            sort: vec![SortKey {
                column: 1,
                descending: true,
            }],
            filters: vec![],
        },
    )
    .await;
    assert_eq!(o.names, ["id", "id"]);
    assert_eq!(o.rows[0][1].as_deref(), Some("50"));

    let o = refine(
        &s,
        "with t as (select generate_series(1, 5) n) select n from t order by n",
        Refinement {
            sort: vec![SortKey {
                column: 0,
                descending: true,
            }],
            filters: vec![],
        },
    )
    .await;
    assert_eq!(col0(&o), ["5", "4", "3", "2", "1"], "outer ORDER BY wins");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn bad_values_get_the_servers_message_and_injection_is_just_a_value() {
    let s = session().await;
    let cols = columns_of(&s, SERIES).await;
    let e = s
        .refine(
            SERIES,
            &cols,
            &Refinement {
                sort: vec![],
                filters: vec![f(0, FilterOp::Eq, Some("abc"))],
            },
            &ExecOptions::default(),
        )
        .await
        .expect_err("not an int");
    assert_eq!(e.sqlstate.as_deref(), Some("22P02"), "{e:?}");
    assert!(e.message.contains("integer"), "{e:?}");
    assert_eq!(e.position, None, "positions would point into generated SQL");

    let attack = "x'); drop table shop.customers; --";
    let o = refine(
        &s,
        "select email from shop.customers",
        Refinement {
            sort: vec![],
            filters: vec![f(0, FilterOp::Eq, Some(attack))],
        },
    )
    .await;
    assert_eq!(o.total, 0);
    let still = refine(
        &s,
        "select count(*) from shop.customers",
        Refinement::default(),
    )
    .await;
    assert_eq!(col0(&still), ["50"], "table intact");
}
