//! Metadata tree against the disposable server (`scripts/test-pg.sh up`).
//! Each test uses its own schema and drops it afterwards.

use std::sync::Arc;
use std::time::{Duration, Instant};

use quarry_db_core::{
    ConnectParams, DatabaseAdapter, MetaKind, MetaNode, MetadataRequest as Req, ObjectType,
    Session, TlsMode,
};
use quarry_db_postgres::PostgresAdapter;
use quarry_secrets::SecretString;

const PORT: u16 = 55432;

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
        port: PORT,
        database: "quarry_test".into(),
        username: "quarry".into(),
        password: Some(SecretString::new(password)),
        tls: TlsMode::Disable,
        connect_timeout: Duration::from_secs(5),
        read_only: false,
        application_name: "quarry-it-meta".into(),
    }
}

/// A plain client for fixtures (DDL), separate from the session under test.
async fn admin() -> tokio_postgres::Client {
    let p = params();
    let mut cfg = tokio_postgres::Config::new();
    cfg.host(&p.host)
        .port(p.port)
        .user(&p.username)
        .dbname(&p.database)
        .password(p.password.as_ref().expect("pw").expose());
    let (client, conn) = cfg
        .connect(tokio_postgres::NoTls)
        .await
        .expect("admin connect");
    tokio::spawn(conn);
    client
}

async fn session() -> Arc<dyn Session> {
    PostgresAdapter
        .connect(&params(), Box::new(|_| {}))
        .await
        .expect("connect")
}

fn names(nodes: &[MetaNode]) -> Vec<&str> {
    nodes.iter().map(|n| n.name.as_str()).collect()
}

fn child(nodes: &[MetaNode], name: &str) -> MetaNode {
    nodes
        .iter()
        .find(|n| n.name == name)
        .unwrap_or_else(|| panic!("{name} not in {:?}", names(nodes)))
        .clone()
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn walks_schema_tables_views_columns_and_indexes() {
    let db = admin().await;
    db.batch_execute(
        r#"DROP SCHEMA IF EXISTS it_walk CASCADE;
        CREATE SCHEMA it_walk;
        CREATE TABLE it_walk.accounts (id serial PRIMARY KEY, email text NOT NULL UNIQUE, note text DEFAULT 'n/a');
        CREATE INDEX accounts_note_idx ON it_walk.accounts (note);
        CREATE TABLE it_walk."odd ""name""" (x int);
        CREATE VIEW it_walk.v_accounts AS SELECT id, email FROM it_walk.accounts;
        CREATE MATERIALIZED VIEW it_walk.mv_accounts AS SELECT count(*) AS n FROM it_walk.accounts;"#,
    )
    .await
    .expect("fixture");
    let s = session().await;

    let schemas = s.metadata(&Req::Schemas).await.expect("schemas");
    assert!(names(&schemas).contains(&"it_walk"));
    assert!(
        !names(&schemas)
            .iter()
            .any(|n| n.starts_with("pg_") || *n == "information_schema")
    );

    let groups = s
        .metadata(&child(&schemas, "it_walk").children.expect("groups"))
        .await
        .expect("groups");
    assert_eq!(names(&groups), ["Tables", "Views", "Materialized views"]);
    assert_eq!(
        groups.iter().map(|g| g.count).collect::<Vec<_>>(),
        [Some(2), Some(1), Some(1)]
    );

    let tables = s
        .metadata(&child(&groups, "Tables").children.expect("tables"))
        .await
        .expect("tables");
    assert_eq!(
        names(&tables),
        ["accounts", "odd \"name\""],
        "quoted identifiers work as bind params"
    );
    assert!(tables.iter().all(|t| t.kind == MetaKind::Table));

    let views = s
        .metadata(&child(&groups, "Views").children.expect("views"))
        .await
        .expect("views");
    let view_groups = s
        .metadata(&child(&views, "v_accounts").children.expect("vg"))
        .await
        .expect("vg");
    assert_eq!(
        names(&view_groups),
        ["Columns"],
        "views have no indexes group"
    );

    let table_groups = s
        .metadata(&child(&tables, "accounts").children.expect("tg"))
        .await
        .expect("tg");
    assert_eq!(names(&table_groups), ["Columns", "Indexes"]);
    assert_eq!(
        table_groups.iter().map(|g| g.count).collect::<Vec<_>>(),
        [Some(3), Some(3)]
    );

    let columns = s
        .metadata(&child(&table_groups, "Columns").children.expect("cols"))
        .await
        .expect("cols");
    assert_eq!(names(&columns), ["id", "email", "note"]);
    let id = child(&columns, "id");
    assert_eq!(id.flags, ["pk", "not null"]);
    assert!(
        id.detail
            .as_deref()
            .is_some_and(|d| d.starts_with("integer = nextval(")),
        "{id:?}"
    );
    assert_eq!(
        child(&columns, "note").detail.as_deref(),
        Some("text = 'n/a'::text")
    );
    assert!(
        columns.iter().all(|c| c.children.is_none()),
        "columns are leaves"
    );

    let indexes = s
        .metadata(&child(&table_groups, "Indexes").children.expect("idx"))
        .await
        .expect("idx");
    assert_eq!(
        names(&indexes),
        ["accounts_pkey", "accounts_email_key", "accounts_note_idx"]
    );
    assert_eq!(child(&indexes, "accounts_pkey").flags, ["primary"]);
    assert_eq!(child(&indexes, "accounts_email_key").flags, ["unique"]);
    assert_eq!(
        child(&indexes, "accounts_note_idx").detail.as_deref(),
        Some("btree (note)")
    );

    s.close().await;
    db.batch_execute("DROP SCHEMA it_walk CASCADE")
        .await
        .expect("cleanup");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn thousand_tables_load_quickly_and_refresh_sees_new_ones() {
    let db = admin().await;
    db.batch_execute(
        "DROP SCHEMA IF EXISTS it_perf CASCADE;
         CREATE SCHEMA it_perf;
         DO $$ BEGIN
           FOR i IN 1..1000 LOOP
             EXECUTE format('CREATE TABLE it_perf.t_%s (id int PRIMARY KEY, v text)', lpad(i::text, 4, '0'));
           END LOOP;
         END $$;",
    )
    .await
    .expect("fixture");
    let s = session().await;
    let request = Req::Objects {
        schema: "it_perf".into(),
        types: vec![ObjectType::Table],
    };

    let started = Instant::now();
    let tables = s.metadata(&request).await.expect("objects");
    let elapsed = started.elapsed();
    assert_eq!(tables.len(), 1000);
    eprintln!("1000 tables loaded in {elapsed:?}");
    assert!(
        elapsed < Duration::from_millis(500),
        "backend share of the 1 s budget: {elapsed:?}"
    );

    db.batch_execute("CREATE TABLE it_perf.zz_new (id int)")
        .await
        .expect("ddl");
    let refreshed = s.metadata(&request).await.expect("refresh");
    assert_eq!(refreshed.len(), 1001);
    assert_eq!(refreshed.last().map(|n| n.name.as_str()), Some("zz_new"));

    s.close().await;
    db.batch_execute("DROP SCHEMA it_perf CASCADE")
        .await
        .expect("cleanup");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn dropped_object_yields_no_children_and_closed_session_errors() {
    let s = session().await;
    let gone = Req::ObjectGroups {
        schema: "public".into(),
        name: "does_not_exist".into(),
        object_type: ObjectType::Table,
    };
    assert!(s.metadata(&gone).await.expect("ok").is_empty());

    s.close().await;
    let err = s.metadata(&Req::Schemas).await.expect_err("closed");
    assert!(err.connection_lost, "{err:?}");
    assert!(s.is_closed());
}
