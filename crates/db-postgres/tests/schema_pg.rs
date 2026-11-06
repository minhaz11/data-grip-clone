//! Schema change tools against the disposable server (`scripts/test-pg.sh up` and `seed`).

use std::sync::Arc;
use std::time::Duration;

use quarry_db_core::{
    CheckModel, ColumnModel, ConnectParams, DatabaseAdapter, DropObject, FkAction, ForeignKeyModel,
    Identity, IndexModel, KeyModel, ObjectRef, ObjectType, RenameObject, SchemaChange, Session,
    TableModel, TableName, TlsMode,
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
        application_name: "quarry-it-schema".into(),
        options: Default::default(),
    }
}

async fn session_with(p: ConnectParams) -> Arc<dyn Session> {
    PostgresAdapter
        .connect(&p, Box::new(|_| {}))
        .await
        .expect("connect")
}

async fn apply(s: &Arc<dyn Session>, change: SchemaChange) -> Vec<String> {
    let statements = PostgresAdapter.preview_schema(&change).expect("preview");
    s.apply_schema(&statements)
        .await
        .unwrap_or_else(|e| panic!("{e:?}\n{statements:#?}"));
    statements
}

fn col(name: &str, ty: &str) -> ColumnModel {
    ColumnModel {
        name: name.into(),
        original: None,
        type_name: ty.into(),
        not_null: false,
        default: None,
        identity: None,
        comment: None,
    }
}

/// A fresh schema for one test.
async fn fresh_schema(s: &Arc<dyn Session>, name: &str) {
    s.apply_schema(&[
        format!("DROP SCHEMA IF EXISTS {name} CASCADE"),
        format!("CREATE SCHEMA {name}"),
    ])
    .await
    .expect("schema");
}

fn orders(schema: &str) -> TableModel {
    TableModel {
        schema: schema.into(),
        name: "orders".into(),
        comment: Some("Customer orders".into()),
        columns: vec![
            ColumnModel {
                identity: Some(Identity::ByDefault),
                not_null: true,
                ..col("id", "bigint")
            },
            ColumnModel {
                not_null: true,
                comment: Some("Shown on invoices".into()),
                ..col("Code", "character varying(20)")
            },
            ColumnModel {
                default: Some("1".into()),
                ..col("qty", "integer")
            },
            col("customer_id", "bigint"),
        ],
        primary_key: Some(KeyModel {
            name: None,
            columns: vec!["id".into()],
        }),
        uniques: vec![KeyModel {
            name: Some("orders_code_key".into()),
            columns: vec!["Code".into()],
        }],
        checks: vec![CheckModel {
            name: Some("qty_positive".into()),
            expression: "qty > 0".into(),
        }],
        foreign_keys: vec![ForeignKeyModel {
            name: Some("orders_customer_fkey".into()),
            columns: vec!["customer_id".into()],
            ref_schema: schema.into(),
            ref_table: "customers".into(),
            ref_columns: vec!["id".into()],
            on_delete: FkAction::Cascade,
            on_update: FkAction::NoAction,
            deferrable: false,
        }],
        indexes: vec![IndexModel {
            name: Some("orders_customer_idx".into()),
            columns: "customer_id, id DESC".into(),
            unique: false,
        }],
    }
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn creates_and_modifies_a_table_from_the_model() {
    let s = session_with(params()).await;
    fresh_schema(&s, "it_schema").await;
    s.apply_schema(&["CREATE TABLE it_schema.customers (id bigint PRIMARY KEY)".into()])
        .await
        .expect("customers");
    apply(
        &s,
        SchemaChange::CreateTable {
            table: orders("it_schema"),
        },
    )
    .await;

    let details = s
        .object_details(&ObjectRef {
            schema: "it_schema".into(),
            name: "orders".into(),
            object_type: ObjectType::Table,
        })
        .await
        .expect("details")
        .expect("created");
    assert_eq!(details.comment.as_deref(), Some("Customer orders"));
    let cols: Vec<(&str, &str, bool)> = details
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c.type_name.as_str(), c.nullable))
        .collect();
    assert_eq!(
        cols,
        [
            ("id", "bigint", false),
            ("Code", "character varying(20)", false),
            ("qty", "integer", true),
            ("customer_id", "bigint", true),
        ]
    );
    assert_eq!(details.columns[0].identity.as_deref(), Some("by default"));
    assert_eq!(
        details.columns[1].comment.as_deref(),
        Some("Shown on invoices")
    );
    assert_eq!(details.references[0].on_delete, "CASCADE");
    assert!(
        details
            .indexes
            .iter()
            .any(|i| i.name == "orders_customer_idx"
                && i.definition == "btree (customer_id, id DESC)")
    );

    // The loaded model of a real table round-trips: no changes, no statements.
    let model = s
        .table_model("it_schema", "orders")
        .await
        .expect("model")
        .expect("exists");
    let noop = PostgresAdapter
        .preview_schema(&SchemaChange::AlterTable {
            original: Box::new(model.clone()),
            table: Box::new(model.clone()),
        })
        .expect("noop");
    assert_eq!(noop, Vec::<String>::new());

    // Modify: rename a column, change a type, add a column, replace the check, drop the unique.
    let mut edited = model.clone();
    edited.columns[1].name = "code".into();
    edited.columns[2].type_name = "bigint".into();
    edited.columns.push(ColumnModel {
        comment: Some("When shipped".into()),
        ..col("shipped_at", "timestamp with time zone")
    });
    edited.checks[0].expression = "qty >= 1".into();
    edited.uniques.clear();
    let statements = apply(
        &s,
        SchemaChange::AlterTable {
            original: Box::new(model),
            table: Box::new(edited),
        },
    )
    .await;
    assert!(
        statements
            .iter()
            .any(|st| st.contains("RENAME COLUMN \"Code\" TO code")),
        "{statements:#?}"
    );
    let after = s
        .table_model("it_schema", "orders")
        .await
        .expect("model")
        .expect("exists");
    let names: Vec<&str> = after.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["id", "code", "qty", "customer_id", "shipped_at"]);
    assert_eq!(after.columns[2].type_name, "bigint");
    assert!(after.uniques.is_empty());
    assert_eq!(after.checks[0].expression, "(qty >= 1)");
    assert_eq!(after.columns[4].comment.as_deref(), Some("When shipped"));
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn a_failing_statement_rolls_back_everything() {
    let s = session_with(params()).await;
    fresh_schema(&s, "it_schema_fail").await;
    let e = s
        .apply_schema(&[
            "CREATE TABLE it_schema_fail.kept (id int)".into(),
            "ALTER TABLE it_schema_fail.missing ADD COLUMN x int".into(),
        ])
        .await
        .expect_err("second statement fails");
    assert!(e.message.starts_with("Statement 2 of 2 failed:"), "{e:?}");
    assert_eq!(e.sqlstate.as_deref(), Some("42P01"));
    let kept = s
        .table_model("it_schema_fail", "kept")
        .await
        .expect("model");
    assert!(kept.is_none(), "the first statement was rolled back");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn read_only_sources_reject_schema_changes() {
    let ro = session_with(ConnectParams {
        read_only: true,
        ..params()
    })
    .await;
    let e = ro
        .apply_schema(&["CREATE TABLE public.it_schema_ro (id int)".into()])
        .await
        .expect_err("read-only");
    assert_eq!(e.sqlstate.as_deref(), Some("25006"), "{e:?}");
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn drops_truncates_and_renames() {
    let s = session_with(params()).await;
    fresh_schema(&s, "it_schema_ops").await;
    s.apply_schema(&[
        "CREATE TABLE it_schema_ops.t (id int GENERATED ALWAYS AS IDENTITY, v text)".into(),
        "INSERT INTO it_schema_ops.t (v) VALUES ('a'), ('b')".into(),
        "CREATE VIEW it_schema_ops.v AS SELECT * FROM it_schema_ops.t".into(),
    ])
    .await
    .expect("fixture");
    let table = || TableName {
        schema: "it_schema_ops".into(),
        name: "t".into(),
    };
    apply(
        &s,
        SchemaChange::Truncate {
            tables: vec![table()],
            restart_identity: true,
            cascade: false,
        },
    )
    .await;
    apply(
        &s,
        SchemaChange::Rename {
            object: RenameObject::Column {
                schema: "it_schema_ops".into(),
                table: "t".into(),
                name: "v".into(),
            },
            new_name: "Value".into(),
        },
    )
    .await;
    let model = s
        .table_model("it_schema_ops", "t")
        .await
        .expect("model")
        .expect("exists");
    assert_eq!(model.columns[1].name, "Value");

    // Without CASCADE the dependent view blocks the drop; nothing changes.
    let blocked = PostgresAdapter
        .preview_schema(&SchemaChange::Drop {
            objects: vec![DropObject::Relation {
                schema: "it_schema_ops".into(),
                name: "t".into(),
                object_type: ObjectType::Table,
            }],
            if_exists: false,
            cascade: false,
        })
        .expect("preview");
    let e = s.apply_schema(&blocked).await.expect_err("dependent view");
    assert_eq!(e.sqlstate.as_deref(), Some("2BP01"), "{e:?}");
    apply(
        &s,
        SchemaChange::Drop {
            objects: vec![DropObject::Relation {
                schema: "it_schema_ops".into(),
                name: "t".into(),
                object_type: ObjectType::Table,
            }],
            if_exists: true,
            cascade: true,
        },
    )
    .await;
    assert!(
        s.table_model("it_schema_ops", "t")
            .await
            .expect("model")
            .is_none()
    );
}
