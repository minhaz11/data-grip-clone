//! Row editing against the disposable server (`scripts/test-pg.sh up`). Uses scratch tables it
//! creates and drops; the sample `shop` data is only read.

use std::sync::Arc;
use std::time::Duration;

use quarry_db_core::{
    ColumnValue, ConnectParams, DatabaseAdapter, EditTarget, Editability, ExecOptions, RowChange,
    Session, StatementOutcome, TlsMode,
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
        application_name: "quarry-it-edit".into(),
    }
}

async fn session_with(p: ConnectParams) -> Arc<dyn Session> {
    PostgresAdapter
        .connect(&p, Box::new(|_| {}))
        .await
        .expect("connect")
}

async fn edit_of(s: &Arc<dyn Session>, sql: &str) -> Editability {
    match s.execute(sql, &ExecOptions::default()).await.expect(sql) {
        StatementOutcome::Rows { edit, cursor, .. } => {
            if let Some(c) = cursor {
                s.close_cursor(&c).await.expect("close");
            }
            edit.expect("cursor results carry editability")
        }
        other => panic!("{other:?}"),
    }
}

fn target(e: Editability) -> EditTarget {
    match e {
        Editability::Editable { target } => target,
        Editability::ReadOnly { reason } => panic!("expected editable, got: {reason}"),
    }
}

fn reason(e: Editability) -> String {
    match e {
        Editability::ReadOnly { reason } => reason,
        Editability::Editable { target } => panic!("expected read-only, got {target:?}"),
    }
}

async fn scalar(s: &Arc<dyn Session>, sql: &str) -> Option<String> {
    match s.execute(sql, &ExecOptions::default()).await.expect(sql) {
        StatementOutcome::Rows { rows, .. } => rows.first().and_then(|r| r[0].clone()),
        other => panic!("{other:?}"),
    }
}

fn v(column: usize, value: Option<&str>) -> ColumnValue {
    ColumnValue {
        column,
        value: value.map(str::to_owned),
    }
}
fn k(x: &str) -> Vec<Option<String>> {
    vec![Some(x.to_owned())]
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn editability_follows_the_source_table_and_its_primary_key() {
    let s = session_with(params()).await;
    let t = target(edit_of(&s, "select * from shop.customers").await);
    assert_eq!(
        (t.schema.as_str(), t.table.as_str(), t.key.as_slice()),
        ("shop", "customers", [0].as_slice())
    );
    assert_eq!(
        t.columns[1].as_ref().map(|c| c.name.as_str()),
        Some("email")
    );

    let t = target(
        edit_of(
            &s,
            "select email as e, id, upper(full_name) as shout from shop.customers c",
        )
        .await,
    );
    assert_eq!(t.key, [1], "key found by origin, not by name or position");
    assert_eq!(
        t.columns[0].as_ref().map(|c| c.name.as_str()),
        Some("email"),
        "base name behind the alias"
    );
    assert!(t.columns[2].is_none(), "computed columns are read-only");

    assert!(
        reason(edit_of(&s, "select email from shop.customers").await).contains("primary key (id)")
    );
    assert!(reason(edit_of(&s, "select o.id, c.email from shop.orders o join shop.customers c on c.id = o.customer_id").await).contains("2 different tables"));
    assert!(reason(edit_of(&s, "select * from shop.order_totals").await).contains("not a table"));
    assert!(
        reason(edit_of(&s, "select count(*) from shop.customers").await)
            .contains("directly from a table")
    );
    s.execute(
        "create temp table it_tmp (id int primary key)",
        &ExecOptions::default(),
    )
    .await
    .expect("temp");
    assert!(reason(edit_of(&s, "select * from it_tmp").await).contains("temporary"));
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn edits_apply_in_one_transaction_with_optimistic_checks() {
    let s = session_with(params()).await;
    let opts = ExecOptions::default();
    s.execute("drop table if exists public.it_edit", &opts)
        .await
        .expect("drop");
    s.execute("create table public.it_edit (id serial primary key, name text not null default 'unnamed', qty int)", &opts).await.expect("create");
    s.execute(
        "insert into public.it_edit (name, qty) values ('a', 1), ('b', 2), ('c', 3)",
        &opts,
    )
    .await
    .expect("seed");
    let t = target(edit_of(&s, "select id, name, qty from public.it_edit order by id").await);

    let preview = s
        .preview_edits(
            &t,
            &[RowChange::Update {
                key: k("1"),
                set: vec![v(1, Some("A"))],
                original: vec![v(1, Some("a"))],
            }],
        )
        .expect("preview");
    assert_eq!(
        preview[0].sql,
        "UPDATE \"public\".\"it_edit\" SET \"name\" = ($1::text)::text WHERE \"id\" = ($2::text)::int4 \
         AND \"name\" IS NOT DISTINCT FROM ($3::text)::text"
    );

    let applied = s
        .apply_edits(
            &t,
            &[
                RowChange::Update {
                    key: k("1"),
                    set: vec![v(1, Some("A")), v(2, None)],
                    original: vec![v(1, Some("a")), v(2, Some("1"))],
                },
                RowChange::Delete { key: k("2") },
                RowChange::Insert {
                    values: vec![v(2, Some("9"))],
                },
            ],
        )
        .await
        .expect("apply");
    assert_eq!(applied, 3);
    assert_eq!(
        scalar(
            &s,
            "select name || '/' || coalesce(qty::text, 'NULL') from public.it_edit where id = 1"
        )
        .await
        .as_deref(),
        Some("A/NULL")
    );
    assert_eq!(
        scalar(&s, "select count(*) from public.it_edit where id = 2")
            .await
            .as_deref(),
        Some("0")
    );
    assert_eq!(
        scalar(
            &s,
            "select name || '/' || qty from public.it_edit where qty = 9"
        )
        .await
        .as_deref(),
        Some("unnamed/9"),
        "omitted columns take defaults"
    );

    // A stale original value (someone changed the row) aborts the whole batch.
    let e = s
        .apply_edits(
            &t,
            &[
                RowChange::Update {
                    key: k("3"),
                    set: vec![v(1, Some("first"))],
                    original: vec![v(1, Some("c"))],
                },
                RowChange::Update {
                    key: k("1"),
                    set: vec![v(1, Some("second"))],
                    original: vec![v(1, Some("stale"))],
                },
            ],
        )
        .await
        .expect_err("conflict");
    assert!(
        e.message.contains("Change 2 of 2 (update) matched no row"),
        "{e:?}"
    );
    assert_eq!(
        scalar(&s, "select name from public.it_edit where id = 3")
            .await
            .as_deref(),
        Some("c"),
        "change 1 rolled back too"
    );

    // Server-side errors are reported per change and roll back.
    let e = s
        .apply_edits(
            &t,
            &[RowChange::Update {
                key: k("3"),
                set: vec![v(2, Some("not a number"))],
                original: vec![],
            }],
        )
        .await
        .expect_err("bad int");
    assert!(
        e.message
            .starts_with("Change 1 of 1 (update) failed: invalid input syntax"),
        "{e:?}"
    );
    assert_eq!(e.sqlstate.as_deref(), Some("22P02"));

    s.execute("drop table public.it_edit", &opts)
        .await
        .expect("cleanup");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn edits_never_touch_the_sessions_open_transaction() {
    let s = session_with(params()).await;
    let opts = ExecOptions::default();
    s.execute("drop table if exists public.it_iso", &opts)
        .await
        .expect("drop");
    s.execute(
        "create table public.it_iso (id int primary key, v text)",
        &opts,
    )
    .await
    .expect("create");
    s.execute("insert into public.it_iso values (1, 'x')", &opts)
        .await
        .expect("seed");
    let t = target(edit_of(&s, "select id, v from public.it_iso").await);

    s.execute("begin", &opts).await.expect("user begin");
    s.execute("insert into public.it_iso values (2, 'uncommitted')", &opts)
        .await
        .expect("user insert");
    s.apply_edits(
        &t,
        &[RowChange::Update {
            key: k("1"),
            set: vec![v(1, Some("edited"))],
            original: vec![],
        }],
    )
    .await
    .expect("apply");
    s.execute("rollback", &opts).await.expect("user rollback");

    assert_eq!(
        scalar(&s, "select v from public.it_iso where id = 1")
            .await
            .as_deref(),
        Some("edited"),
        "edit committed on its own"
    );
    assert_eq!(
        scalar(&s, "select count(*) from public.it_iso where id = 2")
            .await
            .as_deref(),
        Some("0"),
        "user's rollback unaffected"
    );
    s.execute("drop table public.it_iso", &opts)
        .await
        .expect("cleanup");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn read_only_sources_reject_edits_server_side() {
    let rw = session_with(params()).await;
    let opts = ExecOptions::default();
    rw.execute("drop table if exists public.it_ro", &opts)
        .await
        .expect("drop");
    rw.execute(
        "create table public.it_ro (id int primary key, v text)",
        &opts,
    )
    .await
    .expect("create");
    rw.execute("insert into public.it_ro values (1, 'x')", &opts)
        .await
        .expect("seed");

    let ro = session_with(ConnectParams {
        read_only: true,
        ..params()
    })
    .await;
    let t = target(edit_of(&ro, "select id, v from public.it_ro").await);
    let e = ro
        .apply_edits(&t, &[RowChange::Delete { key: k("1") }])
        .await
        .expect_err("read-only");
    assert_eq!(e.sqlstate.as_deref(), Some("25006"), "{e:?}");
    assert_eq!(
        scalar(&rw, "select count(*) from public.it_ro")
            .await
            .as_deref(),
        Some("1")
    );
    rw.execute("drop table public.it_ro", &opts)
        .await
        .expect("cleanup");
}
