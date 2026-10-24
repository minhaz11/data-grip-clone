//! Metadata tree against the disposable server (`scripts/test-pg.sh up`).
//! Each test uses its own schema and drops it afterwards.

use std::sync::Arc;
use std::time::{Duration, Instant};

use quarry_db_core::{
    ConnectOptions, ConnectParams, DatabaseAdapter, MetaKind, MetaNode, MetadataRequest as Req,
    ObjectRef, ObjectType, SchemaScope, Session, TlsMode,
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
        options: Default::default(),
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
    // `id serial` brings a sequence along.
    assert_eq!(
        names(&groups),
        ["Tables", "Views", "Materialized views", "Sequences"]
    );
    assert_eq!(
        groups.iter().map(|g| g.count).collect::<Vec<_>>(),
        [Some(2), Some(1), Some(1), Some(1)]
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
    // Empty groups are hidden: accounts has keys and indexes but no FKs, checks or triggers.
    assert_eq!(names(&table_groups), ["Columns", "Keys", "Indexes"]);
    assert_eq!(
        table_groups.iter().map(|g| g.count).collect::<Vec<_>>(),
        [Some(3), Some(2), Some(3)]
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

    let relations = s.metadata(&Req::Relations).await.expect("relations");
    let mine: Vec<(&str, &str, MetaKind)> = relations
        .iter()
        .filter(|n| n.detail.as_deref() == Some("it_walk"))
        .map(|n| (n.key.as_str(), n.name.as_str(), n.kind))
        .collect();
    assert_eq!(
        mine,
        [
            ("it_walk.accounts", "accounts", MetaKind::Table),
            (
                "it_walk.mv_accounts",
                "mv_accounts",
                MetaKind::MaterializedView
            ),
            ("it_walk.odd \"name\"", "odd \"name\"", MetaKind::Table),
            ("it_walk.v_accounts", "v_accounts", MetaKind::View),
        ]
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

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn shows_keys_foreign_keys_checks_triggers_routines_and_sequences() {
    let db = admin().await;
    db.batch_execute(
        r#"DROP SCHEMA IF EXISTS it_kinds CASCADE;
        CREATE SCHEMA it_kinds;
        CREATE TABLE it_kinds.customers (id serial PRIMARY KEY, name text);
        COMMENT ON TABLE it_kinds.customers IS 'People who buy';
        CREATE TABLE it_kinds.orders (
            id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            code text NOT NULL,
            customer_id int REFERENCES it_kinds.customers (id) ON DELETE CASCADE
                DEFERRABLE INITIALLY DEFERRED,
            qty int NOT NULL DEFAULT 1 CONSTRAINT qty_positive CHECK (qty > 0),
            doubled int GENERATED ALWAYS AS (qty * 2) STORED,
            CONSTRAINT orders_code_key UNIQUE (code)
        );
        COMMENT ON COLUMN it_kinds.orders.code IS 'Shown on invoices';
        CREATE TABLE it_kinds.lines (
            order_id int, line int, PRIMARY KEY (order_id, line),
            FOREIGN KEY (order_id) REFERENCES it_kinds.orders (id)
        );
        CREATE FUNCTION it_kinds.touch() RETURNS trigger LANGUAGE plpgsql
            AS $$ BEGIN RETURN NEW; END $$;
        CREATE TRIGGER orders_touch BEFORE INSERT OR UPDATE ON it_kinds.orders
            FOR EACH ROW EXECUTE FUNCTION it_kinds.touch();
        CREATE TRIGGER "Odd trigger" AFTER DELETE ON it_kinds.orders
            FOR EACH STATEMENT EXECUTE FUNCTION it_kinds.touch();
        ALTER TABLE it_kinds.orders DISABLE TRIGGER "Odd trigger";
        CREATE FUNCTION it_kinds.price(qty int) RETURNS numeric LANGUAGE sql AS 'SELECT 1.0';
        CREATE FUNCTION it_kinds.price(code text) RETURNS numeric LANGUAGE sql AS 'SELECT 2.0';
        CREATE PROCEDURE it_kinds.archive() LANGUAGE sql AS 'SELECT 1';
        CREATE SEQUENCE it_kinds.invoice_no AS bigint INCREMENT BY 5;
        INSERT INTO it_kinds.customers (name) VALUES ('a'), ('b');
        ANALYZE it_kinds.customers;"#,
    )
    .await
    .expect("fixture");
    let s = session().await;
    let schema = "it_kinds".to_owned();

    let groups = s
        .metadata(&Req::SchemaGroups {
            schema: schema.clone(),
        })
        .await
        .expect("groups");
    assert_eq!(names(&groups), ["Tables", "Views", "Routines", "Sequences"]);
    // touch, price x2, archive; the serial and identity sequences, and invoice_no.
    assert_eq!(child(&groups, "Routines").count, Some(4));
    assert_eq!(child(&groups, "Sequences").count, Some(3));

    let object_groups = s
        .metadata(&Req::ObjectGroups {
            schema: schema.clone(),
            name: "orders".into(),
            object_type: ObjectType::Table,
        })
        .await
        .expect("object groups");
    assert_eq!(
        names(&object_groups),
        [
            "Columns",
            "Keys",
            "Foreign keys",
            "Checks",
            "Indexes",
            "Triggers"
        ]
    );
    let load = |name: &str| child(&object_groups, name).children.expect("children");

    let keys = s.metadata(&load("Keys")).await.expect("keys");
    assert_eq!(names(&keys), ["orders_pkey", "orders_code_key"]);
    assert_eq!(keys[0].kind, MetaKind::Key);
    assert_eq!(keys[0].detail.as_deref(), Some("PRIMARY KEY (id)"));
    assert_eq!(keys[0].flags, ["primary"]);
    assert_eq!(keys[1].flags, ["unique"]);

    let fks = s.metadata(&load("Foreign keys")).await.expect("fks");
    assert_eq!(fks.len(), 1);
    let fk = fks[0].detail.as_deref().unwrap_or_default();
    assert!(
        fk.contains("REFERENCES it_kinds.customers(id) ON DELETE CASCADE DEFERRABLE"),
        "{fk}"
    );

    let checks = s.metadata(&load("Checks")).await.expect("checks");
    assert_eq!(names(&checks), ["qty_positive"]);
    assert_eq!(checks[0].detail.as_deref(), Some("CHECK (qty > 0)"));

    let triggers = s.metadata(&load("Triggers")).await.expect("triggers");
    assert_eq!(names(&triggers), ["Odd trigger", "orders_touch"]);
    assert!(
        triggers[1]
            .detail
            .as_deref()
            .is_some_and(|d| d.starts_with("BEFORE INSERT OR UPDATE ON it_kinds.orders")),
        "{:?}",
        triggers[1].detail
    );
    assert_eq!(triggers[0].flags, ["disabled"]);
    assert!(
        triggers[0]
            .detail
            .as_deref()
            .is_some_and(|d| d.starts_with("AFTER DELETE")),
        "quoted names are stripped too: {:?}",
        triggers[0].detail
    );

    let routines = s
        .metadata(&child(&groups, "Routines").children.expect("routines"))
        .await
        .expect("routines");
    let signatures: Vec<(&str, &str)> = routines
        .iter()
        .map(|r| (r.name.as_str(), r.detail.as_deref().unwrap_or_default()))
        .collect();
    assert_eq!(
        signatures,
        [
            ("archive", "()"),
            ("price", "(code text) → numeric"),
            ("price", "(qty integer) → numeric"),
            ("touch", "() → trigger"),
        ]
    );
    assert_eq!(routines[0].flags, ["procedure"]);
    let keys: std::collections::HashSet<&str> = routines.iter().map(|r| r.key.as_str()).collect();
    assert_eq!(keys.len(), 4, "overloads have distinct keys");

    let sequences = s
        .metadata(&child(&groups, "Sequences").children.expect("sequences"))
        .await
        .expect("sequences");
    let seqs: Vec<(&str, &str)> = sequences
        .iter()
        .map(|r| (r.name.as_str(), r.detail.as_deref().unwrap_or_default()))
        .collect();
    assert_eq!(
        seqs,
        [
            (
                "customers_id_seq",
                "integer, owned by it_kinds.customers.id"
            ),
            ("invoice_no", "bigint, increment 5"),
            ("orders_id_seq", "integer, owned by it_kinds.orders.id"),
        ]
    );

    // The table viewer reads everything about one object at once.
    let orders = s
        .object_details(&ObjectRef {
            schema: schema.clone(),
            name: "orders".into(),
            object_type: ObjectType::Table,
        })
        .await
        .expect("details")
        .expect("exists");
    let cols: Vec<&str> = orders.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(cols, ["id", "code", "customer_id", "qty", "doubled"]);
    let id = &orders.columns[0];
    assert!(id.primary_key && !id.nullable);
    assert_eq!(id.identity.as_deref(), Some("always"));
    assert_eq!(
        orders.columns[1].comment.as_deref(),
        Some("Shown on invoices")
    );
    assert_eq!(orders.columns[3].default.as_deref(), Some("1"));
    assert_eq!(orders.columns[4].generated.as_deref(), Some("(qty * 2)"));
    assert_eq!(
        orders.columns[4].default, None,
        "generation is not a default"
    );
    let constraint_kinds: Vec<(&str, &str)> = orders
        .constraints
        .iter()
        .map(|c| (c.name.as_str(), c.kind.as_str()))
        .collect();
    assert_eq!(
        constraint_kinds,
        [
            ("orders_pkey", "primary key"),
            ("orders_code_key", "unique"),
            ("qty_positive", "check")
        ]
    );
    assert_eq!(orders.indexes.len(), 2);
    assert_eq!(orders.references.len(), 1);
    let out = &orders.references[0];
    assert_eq!(
        (
            out.to_table.as_str(),
            out.to_columns.clone(),
            out.on_delete.as_str(),
            out.deferrable
        ),
        ("customers", vec!["id".to_owned()], "CASCADE", true)
    );
    let incoming: Vec<(&str, Vec<String>)> = orders
        .referenced_by
        .iter()
        .map(|k| (k.from_table.as_str(), k.from_columns.clone()))
        .collect();
    assert_eq!(incoming, [("lines", vec!["order_id".to_owned()])]);
    assert_eq!(orders.triggers.len(), 2);
    assert!(orders.total_bytes.is_some_and(|b| b > 0));

    let customers = s
        .object_details(&ObjectRef {
            schema: schema.clone(),
            name: "customers".into(),
            object_type: ObjectType::Table,
        })
        .await
        .expect("details")
        .expect("exists");
    assert_eq!(customers.comment.as_deref(), Some("People who buy"));
    assert_eq!(customers.row_estimate, Some(2), "analyzed");
    assert_eq!(customers.referenced_by.len(), 1);

    let missing = s
        .object_details(&ObjectRef {
            schema: schema.clone(),
            name: "nope".into(),
            object_type: ObjectType::Table,
        })
        .await
        .expect("details");
    assert!(missing.is_none());

    db.batch_execute("DROP SCHEMA it_kinds CASCADE")
        .await
        .expect("cleanup");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn schema_scope_limits_introspection() {
    let db = admin().await;
    db.batch_execute(
        "DROP SCHEMA IF EXISTS it_scope_a, it_scope_b1, it_scope_out CASCADE;
         CREATE SCHEMA it_scope_a; CREATE SCHEMA it_scope_b1; CREATE SCHEMA it_scope_out;
         CREATE TABLE it_scope_a.t (x int); CREATE TABLE it_scope_b1.t (x int);
         CREATE TABLE it_scope_out.t (x int);
         CREATE FUNCTION it_scope_out.f() RETURNS int LANGUAGE sql AS 'select 1';
         CREATE FUNCTION it_scope_a.f() RETURNS int LANGUAGE sql AS 'select 1';",
    )
    .await
    .expect("fixture");

    let scope = SchemaScope {
        names: vec!["it_scope_a".into()],
        patterns: vec!["it_scope_b?".into()],
    };
    let s = PostgresAdapter
        .connect(
            &ConnectParams {
                options: ConnectOptions {
                    schema_scope: scope.clone(),
                    ..Default::default()
                },
                ..params()
            },
            Box::new(|_| {}),
        )
        .await
        .expect("connect");

    let schemas = s.metadata(&Req::Schemas).await.expect("schemas");
    assert_eq!(names(&schemas), ["it_scope_a", "it_scope_b1"]);
    let all = s.metadata(&Req::AllSchemas).await.expect("all");
    assert!(names(&all).contains(&"it_scope_out") && names(&all).contains(&"public"));

    let relations = s.metadata(&Req::Relations).await.expect("rel");
    let mut schemas_of: Vec<&str> = relations
        .iter()
        .filter_map(|n| n.detail.as_deref())
        .collect();
    schemas_of.dedup();
    assert_eq!(schemas_of, ["it_scope_a", "it_scope_b1"]);

    let functions = s.metadata(&Req::Functions).await.expect("fn");
    let keys: Vec<&str> = functions.iter().map(|n| n.key.as_str()).collect();
    assert!(keys.contains(&"it_scope_a\u{1f}f()"), "{keys:?}");
    assert!(!keys.iter().any(|k| k.starts_with("it_scope_out")));
    // Built-ins stay available for completion whatever the scope.
    assert!(keys.iter().any(|k| k.starts_with("pg_catalog\u{1f}now(")));

    // An edited scope applies to the live session at once; the empty scope means everything.
    s.set_schema_scope(SchemaScope::default());
    let schemas = s.metadata(&Req::Schemas).await.expect("schemas");
    assert!(names(&schemas).contains(&"it_scope_out"));

    s.close().await;
    db.batch_execute("DROP SCHEMA it_scope_a, it_scope_b1, it_scope_out CASCADE")
        .await
        .expect("cleanup");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn catalog_lists_relations_sequences_and_user_routines() {
    let db = admin().await;
    db.batch_execute(
        "DROP SCHEMA IF EXISTS it_catalog CASCADE;
         CREATE SCHEMA it_catalog;
         CREATE TABLE it_catalog.orders (id serial PRIMARY KEY);
         CREATE VIEW it_catalog.recent AS SELECT * FROM it_catalog.orders;
         CREATE MATERIALIZED VIEW it_catalog.totals AS SELECT count(*) FROM it_catalog.orders;
         CREATE SEQUENCE it_catalog.ticket_no;
         CREATE FUNCTION it_catalog.price(qty integer, rate numeric) RETURNS numeric
           LANGUAGE sql AS 'select qty * rate';",
    )
    .await
    .expect("fixture");
    let s = session().await;
    let all = s.metadata(&Req::Catalog).await.expect("catalog");
    let ours: Vec<(&str, MetaKind)> = all
        .iter()
        .filter(|n| n.detail.as_deref() == Some("it_catalog"))
        .map(|n| (n.key.as_str(), n.kind))
        .collect();
    assert_eq!(
        ours,
        [
            ("it_catalog\u{1f}o:orders", MetaKind::Table),
            ("it_catalog\u{1f}q:orders_id_seq", MetaKind::Sequence),
            (
                "it_catalog\u{1f}r:price(qty integer, rate numeric)",
                MetaKind::Routine
            ),
            ("it_catalog\u{1f}o:recent", MetaKind::View),
            ("it_catalog\u{1f}q:ticket_no", MetaKind::Sequence),
            ("it_catalog\u{1f}o:totals", MetaKind::MaterializedView),
        ]
    );
    // System schemas stay out; extension-owned routines too (none here).
    assert!(
        all.iter()
            .all(|n| n.detail.as_deref() != Some("pg_catalog"))
    );
    s.close().await;
    db.batch_execute("DROP SCHEMA it_catalog CASCADE")
        .await
        .expect("cleanup");
}
