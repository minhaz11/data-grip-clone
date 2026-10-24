//! File import end to end against the disposable server (`scripts/test-pg.sh up`): reader,
//! checks, COPY in one transaction, error policies, cancel and memory use.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use quarry_db_core::{ConnectParams, DatabaseAdapter, Session, TableName, TlsMode};
use quarry_db_postgres::PostgresAdapter;
use quarry_io::import::{
    ColumnMapping, ErrorPolicy, FileKind, ImportFormat, ImportPlan, import_file, preview,
};
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
        application_name: "quarry-it-import".into(),
        options: Default::default(),
    }
}

async fn session() -> Arc<dyn Session> {
    PostgresAdapter
        .connect(&params(), Box::new(|_| {}))
        .await
        .expect("connect")
}

async fn exec(s: &Arc<dyn Session>, sql: &str) {
    s.execute(sql, &Default::default()).await.expect(sql);
}

async fn count(s: &Arc<dyn Session>, sql: &str) -> Option<String> {
    match s.execute(sql, &Default::default()).await.expect(sql) {
        quarry_db_core::StatementOutcome::Rows { rows, .. } => {
            rows.into_iter().next().and_then(|r| r[0].clone())
        }
        other => panic!("{other:?}"),
    }
}

fn file(text: &str) -> tempfile::NamedTempFile {
    let mut f = tempfile::NamedTempFile::new().expect("temp");
    f.write_all(text.as_bytes()).expect("write");
    f
}

fn mapping(columns: &[(&str, &str)]) -> Vec<ColumnMapping> {
    columns
        .iter()
        .enumerate()
        .map(|(i, (name, ty))| ColumnMapping {
            source: i,
            target: (*name).into(),
            type_name: (*ty).into(),
        })
        .collect()
}

fn plan(table: &str, columns: &[(&str, &str)], policy: ErrorPolicy) -> ImportPlan {
    ImportPlan {
        format: ImportFormat::default(),
        source_columns: columns.iter().map(|(n, _)| (*n).to_owned()).collect(),
        mapping: mapping(columns),
        table: TableName {
            schema: "it_import".into(),
            name: table.into(),
        },
        setup: Vec::new(),
        policy,
    }
}

const PEOPLE: &[(&str, &str)] = &[("id", "integer"), ("name", "text"), ("born", "date")];
const PEOPLE_CSV: &str =
    "id,name,born\n1,Ann,1990-01-02\nx,Bad id,1990-01-02\n3,Cy,1990-02-30\n4,\"Dee, Jr.\",\n";

async fn fresh(s: &Arc<dyn Session>) {
    exec(
        s,
        "DROP SCHEMA IF EXISTS it_import CASCADE; CREATE SCHEMA it_import;
         CREATE TABLE it_import.people (id integer, name text, born date)",
    )
    .await;
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn error_policies_abort_skip_or_null() {
    let s = session().await;
    fresh(&s).await;
    let f = file(PEOPLE_CSV);
    let never = AtomicBool::new(false);

    // Abort: the first bad row stops the import and nothing stays.
    let err = import_file(
        s.as_ref(),
        f.path(),
        &plan("people", PEOPLE, ErrorPolicy::Abort),
        &never,
        &|_| {},
    )
    .await
    .expect_err("abort");
    assert!(err.to_string().contains("Line 3, column id"), "{err}");
    assert_eq!(
        count(&s, "select count(*) from it_import.people")
            .await
            .as_deref(),
        Some("0")
    );

    // Skip: valid rows load, the others are listed with their lines.
    let summary = import_file(
        s.as_ref(),
        f.path(),
        &plan("people", PEOPLE, ErrorPolicy::Skip),
        &never,
        &|_| {},
    )
    .await
    .expect("skip");
    assert_eq!((summary.rows, summary.rejected_count), (2, 2));
    let lines: Vec<(u64, Option<&str>)> = summary
        .rejected
        .iter()
        .map(|r| (r.line, r.column.as_deref()))
        .collect();
    assert_eq!(lines, [(3, Some("id")), (4, Some("born"))]);
    assert_eq!(
        count(
            &s,
            "select string_agg(name, '|' order by id) from it_import.people"
        )
        .await
        .as_deref(),
        Some("Ann|Dee, Jr.")
    );

    // NULL: every row loads; values that do not fit become NULL.
    exec(&s, "truncate it_import.people").await;
    let summary = import_file(
        s.as_ref(),
        f.path(),
        &plan("people", PEOPLE, ErrorPolicy::Null),
        &never,
        &|_| {},
    )
    .await
    .expect("null");
    assert_eq!((summary.rows, summary.nulled), (4, 2));
    assert_eq!(
        count(
            &s,
            "select count(*) from it_import.people where id is null or born is null"
        )
        .await
        .as_deref(),
        Some("3")
    );
    exec(&s, "DROP SCHEMA it_import CASCADE").await;
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn a_new_table_and_its_rows_are_created_together() {
    let s = session().await;
    exec(
        &s,
        "DROP SCHEMA IF EXISTS it_import CASCADE; CREATE SCHEMA it_import",
    )
    .await;
    let f = file(PEOPLE_CSV);
    let mut p = plan("created", PEOPLE, ErrorPolicy::Abort);
    p.setup = vec!["CREATE TABLE it_import.created (id integer, name text, born date)".into()];
    import_file(s.as_ref(), f.path(), &p, &AtomicBool::new(false), &|_| {})
        .await
        .expect_err("bad row");
    // The failed load took the CREATE TABLE with it.
    assert_eq!(
        count(
            &s,
            "select count(*) from pg_tables where schemaname = 'it_import'"
        )
        .await
        .as_deref(),
        Some("0")
    );
    p.policy = ErrorPolicy::Skip;
    let summary = import_file(s.as_ref(), f.path(), &p, &AtomicBool::new(false), &|_| {})
        .await
        .expect("create and load");
    assert_eq!(summary.rows, 2);
    assert_eq!(
        count(&s, "select count(*) from it_import.created")
            .await
            .as_deref(),
        Some("2")
    );
    exec(&s, "DROP SCHEMA it_import CASCADE").await;
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn json_arrays_and_lines_import_by_key() {
    let s = session().await;
    fresh(&s).await;
    for (kind, text) in [
        (
            FileKind::JsonArray,
            r#"[{"id": 1, "name": "Ann", "born": "1990-01-02"}, {"name": "Bo", "id": 2}]"#,
        ),
        (
            FileKind::JsonLines,
            "{\"id\": 3, \"name\": \"Cy\", \"extra\": true}\n\n{\"id\": 4, \"born\": null}\n",
        ),
    ] {
        let f = file(text);
        let format = ImportFormat {
            kind,
            ..ImportFormat::default()
        };
        let (columns, _) = preview(f.path(), &format, 100).expect("preview");
        let mapping = ["id", "name", "born"]
            .iter()
            .zip(["integer", "text", "date"])
            .map(|(name, ty)| ColumnMapping {
                source: columns.iter().position(|c| c == name).unwrap_or(usize::MAX),
                target: (*name).into(),
                type_name: ty.into(),
            })
            .collect();
        let p = ImportPlan {
            format,
            source_columns: columns,
            mapping,
            table: TableName {
                schema: "it_import".into(),
                name: "people".into(),
            },
            setup: Vec::new(),
            policy: ErrorPolicy::Abort,
        };
        let summary = import_file(s.as_ref(), f.path(), &p, &AtomicBool::new(false), &|_| {})
            .await
            .expect("json");
        assert_eq!(summary.rows, 2, "{kind:?}");
    }
    assert_eq!(
        count(
            &s,
            "select string_agg(coalesce(name, '-'), '|' order by id) from it_import.people"
        )
        .await
        .as_deref(),
        Some("Ann|Bo|Cy|-")
    );
    exec(&s, "DROP SCHEMA it_import CASCADE").await;
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn read_only_sources_cannot_import() {
    let s = PostgresAdapter
        .connect(
            &ConnectParams {
                read_only: true,
                ..params()
            },
            Box::new(|_| {}),
        )
        .await
        .expect("connect");
    let f = file("id\n1\n");
    let err = import_file(
        s.as_ref(),
        f.path(),
        &plan("people", &[("id", "integer")], ErrorPolicy::Abort),
        &AtomicBool::new(false),
        &|_| {},
    )
    .await
    .expect_err("read-only");
    assert!(err.to_string().contains("read-only"), "{err}");
}

/// One million rows: memory stays flat (the file is never held whole), progress arrives, and
/// a cancel part-way leaves no rows.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs scripts/test-pg.sh up"]
async fn a_million_rows_import_in_bounded_memory_and_cancel_leaves_none() {
    let s = session().await;
    exec(
        &s,
        "DROP SCHEMA IF EXISTS it_import CASCADE; CREATE SCHEMA it_import;
         CREATE TABLE it_import.big (id bigint, label text, amount numeric(12,2), at timestamp)",
    )
    .await;
    let mut f = tempfile::NamedTempFile::new().expect("temp");
    {
        let mut w = std::io::BufWriter::new(f.as_file_mut());
        writeln!(w, "id,label,amount,at").expect("header");
        for i in 0..1_000_000u64 {
            writeln!(
                w,
                "{i},\"row {i}, with a comma\",{}.{:02},2024-01-01 10:{:02}:00",
                i % 100_000,
                i % 100,
                i % 60
            )
            .expect("row");
        }
    }
    let columns = [
        ("id", "bigint"),
        ("label", "text"),
        ("amount", "numeric(12,2)"),
        ("at", "timestamp"),
    ];
    let mut p = plan("big", &columns, ErrorPolicy::Abort);
    p.source_columns = columns.iter().map(|(n, _)| (*n).to_owned()).collect();

    let baseline = memory_stats::memory_stats().map_or(0, |m| m.physical_mem);
    let peak = Arc::new(Mutex::new(baseline));
    let sampling = Arc::new(AtomicBool::new(true));
    let sampler = {
        let (peak, sampling) = (Arc::clone(&peak), Arc::clone(&sampling));
        std::thread::spawn(move || {
            while sampling.load(Ordering::Relaxed) {
                if let Some(m) = memory_stats::memory_stats() {
                    let mut p = peak.lock().expect("lock");
                    *p = (*p).max(m.physical_mem);
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        })
    };
    let progress_seen = Arc::new(Mutex::new(0u64));
    let summary = {
        let progress_seen = Arc::clone(&progress_seen);
        import_file(
            s.as_ref(),
            f.path(),
            &p,
            &AtomicBool::new(false),
            &move |pr| {
                *progress_seen.lock().expect("lock") = pr.bytes;
            },
        )
        .await
        .expect("import")
    };
    sampling.store(false, Ordering::Relaxed);
    sampler.join().expect("sampler");
    assert_eq!(summary.rows, 1_000_000);
    assert_eq!(
        count(&s, "select count(*) from it_import.big")
            .await
            .as_deref(),
        Some("1000000")
    );
    let file_size = f.as_file().metadata().expect("meta").len();
    assert_eq!(*progress_seen.lock().expect("lock"), file_size);
    let grew = peak.lock().expect("lock").saturating_sub(baseline);
    eprintln!(
        "1M rows ({} MB file) in {} ms, peak memory growth {} MB",
        file_size >> 20,
        summary.elapsed_ms,
        grew >> 20
    );
    assert!(
        grew < 64 << 20,
        "memory grew by {} MB for a {} MB file",
        grew >> 20,
        file_size >> 20
    );

    // Cancel after the first progress report: nothing new stays.
    exec(&s, "truncate it_import.big").await;
    let cancel = Arc::new(AtomicBool::new(false));
    let summary = {
        let cancel = Arc::clone(&cancel);
        import_file(s.as_ref(), f.path(), &p, &cancel.clone(), &move |pr| {
            if pr.rows > 0 {
                cancel.store(true, Ordering::Relaxed);
            }
        })
        .await
        .expect("cancelled")
    };
    assert!(summary.cancelled);
    assert_eq!(
        count(&s, "select count(*) from it_import.big")
            .await
            .as_deref(),
        Some("0")
    );
    exec(&s, "DROP SCHEMA it_import CASCADE").await;
}
