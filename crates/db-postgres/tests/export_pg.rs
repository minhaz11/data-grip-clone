//! Export and copy end to end: cursor pages → quarry-io writer → file or text, as
//! `result_export` and `result_copy` do.

use std::io::BufWriter;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use quarry_db_core::{
    Cell, ColumnInfo, ConnectParams, DatabaseAdapter, ExecOptions, Session, StatementOutcome,
    TableName, TlsMode,
};
use quarry_db_postgres::PostgresAdapter;
use quarry_io::{
    CopyOutcome, ExportOutcome, ExportWriter, Format, WriteOptions, copy_to_string, export_to_file,
    format_rows, partial_path,
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
        application_name: "quarry-it-export".into(),
        options: Default::default(),
    }
}

const SQL: &str = "select g as id, case when g % 10 = 0 then null when g % 10 = 1 then '' else 'v,' || g end as note, \
                   (g * 1.5)::numeric as amount from generate_series(1, 100000) g";

async fn export(s: &Arc<dyn Session>, format: Format, path: &std::path::Path) -> u64 {
    let (columns, cursor) = match s
        .execute(SQL, &ExecOptions::default())
        .await
        .expect("query")
    {
        StatementOutcome::Rows {
            columns, cursor, ..
        } => (columns, cursor.expect("cursor")),
        other => panic!("{other:?}"),
    };
    let file = std::fs::File::create(path).expect("create");
    let mut w = ExportWriter::new(
        BufWriter::new(file),
        format,
        &columns,
        &WriteOptions::default(),
    )
    .expect("writer");
    let opts = ExecOptions {
        max_cell_chars: usize::MAX,
        ..ExecOptions::default()
    };
    let mut offset = 0;
    loop {
        let page = s.fetch(&cursor, offset, 5_000, &opts).await.expect("page");
        if page.is_empty() {
            break;
        }
        offset += page.len() as u64;
        w.write_rows(&page).expect("write");
    }
    s.close_cursor(&cursor).await.expect("close");
    w.finish().expect("finish").1
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn exported_files_match_row_count_and_content() {
    let s = PostgresAdapter
        .connect(&params(), Box::new(|_| {}))
        .await
        .expect("connect");
    let dir = tempfile::tempdir().expect("tempdir");

    let csv_path = dir.path().join("out.csv");
    assert_eq!(export(&s, Format::Csv, &csv_path).await, 100_000);
    let csv = std::fs::read_to_string(&csv_path).expect("read csv");
    let lines: Vec<&str> = csv.lines().collect();
    assert_eq!(lines.len(), 100_001, "header + every row");
    assert_eq!(lines[0], "id,note,amount");
    assert_eq!(lines[1], "1,\"\",1.5", "empty string is quoted");
    assert_eq!(
        lines[2], "2,\"v,2\",3.0",
        "delimiter inside a value is quoted"
    );
    assert_eq!(lines[10], "10,,15.0", "NULL is an empty unquoted field");
    assert_eq!(lines[100_000], "100000,,150000.0");

    let json_path = dir.path().join("out.json");
    assert_eq!(export(&s, Format::Json, &json_path).await, 100_000);
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&json_path).expect("read json"))
            .expect("valid JSON");
    let rows = parsed.as_array().expect("array");
    assert_eq!(rows.len(), 100_000);
    assert_eq!(
        rows[1],
        serde_json::json!({ "id": 2, "note": "v,2", "amount": 3.0 })
    );
    assert_eq!(rows[9]["note"], serde_json::Value::Null);
    assert_eq!(rows[99_999]["id"], 100_000);
}

async fn query(s: &Arc<dyn Session>, sql: &str) -> (Vec<ColumnInfo>, String) {
    match s.execute(sql, &ExecOptions::default()).await.expect(sql) {
        StatementOutcome::Rows {
            columns, cursor, ..
        } => (columns, cursor.expect("cursor")),
        other => panic!("{other:?}"),
    }
}

async fn all_rows(s: &Arc<dyn Session>, cursor: &str) -> Vec<Vec<Cell>> {
    let opts = ExecOptions {
        max_cell_chars: usize::MAX,
        ..ExecOptions::default()
    };
    s.fetch(cursor, 0, 1_000, &opts).await.expect("rows")
}

#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn cancelled_export_leaves_no_file_behind() {
    let s = PostgresAdapter
        .connect(&params(), Box::new(|_| {}))
        .await
        .expect("connect");
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("out.csv");
    let (columns, cursor) = query(&s, SQL).await;
    let cancel = AtomicBool::new(false);
    // Cancel once the first page has been handed to the writer.
    let outcome = export_to_file(
        s.as_ref(),
        &cursor,
        &columns,
        Format::Csv,
        &WriteOptions::default(),
        &path,
        &cancel,
        &|_| cancel.store(true, Ordering::Relaxed),
    )
    .await
    .expect("export");
    assert_eq!(outcome, ExportOutcome::Cancelled);
    assert!(!path.exists(), "no export file");
    assert!(
        !partial_path(&path, Format::Csv).exists(),
        "no partial file"
    );
    assert_eq!(
        std::fs::read_dir(dir.path()).expect("dir").count(),
        0,
        "nothing left in the folder"
    );

    // Without cancel the same export completes.
    let (columns, cursor) = query(&s, SQL).await;
    let outcome = export_to_file(
        s.as_ref(),
        &cursor,
        &columns,
        Format::Csv,
        &WriteOptions::default(),
        &path,
        &AtomicBool::new(false),
        &|_| {},
    )
    .await
    .expect("export");
    assert!(
        matches!(outcome, ExportOutcome::Written { rows: 100_000, .. }),
        "{outcome:?}"
    );
}

const TRICKY: &str = "create table public.{t} (id int primary key, note text, flag bool, \
    amount numeric, doc jsonb, tags text[], raw bytea, at timestamptz)";
const TRICKY_ROWS: &str = "insert into public.{t} values \
    (1, 'plain', true, 1.50, '{\"a\": [1, 2]}', '{x,y}', '\\x6869', '2026-10-23 10:00:00+00'), \
    (2, E'tab\\there, comma \"quoted\" it''s', false, -0.001, '\"s\"', '{\"a b\",NULL}', '\\x', now()), \
    (3, E'line1\\nline2\\r\\nline3 | pipe \\\\ backslash', null, 1e20, 'null', '{}', null, null), \
    (4, '', null, null, null, null, null, null), \
    (5, null, true, 0, '[]', '{\"\"}', '\\x00ff', '-infinity'), \
    (6, 'unicode: é 漢字 🙂', false, 'NaN', '{\"k\": \"v\\\\u0000x\"}', '{1}', '\\x27', 'infinity')";

/// A table of awkward values named `table`, and an empty copy of it named `<table>_target`.
async fn tricky_table(s: &Arc<dyn Session>, table: &str) {
    s.apply_schema(&[
        format!("drop table if exists public.{table}, public.{table}_target"),
        TRICKY.replace("{t}", table),
        TRICKY_ROWS.replace("{t}", table),
        format!("create table public.{table}_target (like public.{table} including all)"),
    ])
    .await
    .expect("fixture");
}

/// Copy output parses back to the same values with a real CSV/TSV and JSON parser.
#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn copy_formats_round_trip_through_parsers() {
    let s = PostgresAdapter
        .connect(&params(), Box::new(|_| {}))
        .await
        .expect("connect");
    tricky_table(&s, "it_copy_parse").await;
    let sql = "select * from public.it_copy_parse order by id";
    let (columns, cursor) = query(&s, sql).await;
    let expected = all_rows(&s, &cursor).await;
    assert_eq!(expected.len(), 6);

    for (format, delimiter) in [(Format::Csv, b','), (Format::Tsv, b'\t')] {
        let options = WriteOptions {
            null_text: Some("\\N".into()),
            ..WriteOptions::default()
        };
        let (columns, cursor) = query(&s, sql).await;
        let text = match copy_to_string(
            s.as_ref(),
            &cursor,
            &columns,
            format,
            &options,
            usize::MAX,
            &AtomicBool::new(false),
            &|_| {},
        )
        .await
        .expect("copy")
        {
            CopyOutcome::Copied { text, rows } => {
                assert_eq!(rows, 6);
                text
            }
            CopyOutcome::Cancelled => panic!("cancelled"),
        };
        let mut reader = csv::ReaderBuilder::new()
            .delimiter(delimiter)
            .from_reader(text.as_bytes());
        let header: Vec<String> = reader
            .headers()
            .expect("header")
            .iter()
            .map(str::to_owned)
            .collect();
        let names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
        assert_eq!(header, names);
        let parsed: Vec<Vec<String>> = reader
            .records()
            .map(|r| r.expect("record").iter().map(str::to_owned).collect())
            .collect();
        let want: Vec<Vec<String>> = expected
            .iter()
            .map(|r| {
                r.iter()
                    .map(|c| c.clone().unwrap_or_else(|| "\\N".into()))
                    .collect()
            })
            .collect();
        assert_eq!(parsed, want, "{format:?}");
    }

    let json =
        format_rows(Format::Json, &columns, &expected, &WriteOptions::default()).expect("json");
    let parsed: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
    let rows = parsed.as_array().expect("array");
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[1]["note"], "tab\there, comma \"quoted\" it's");
    assert_eq!(rows[2]["note"], "line1\nline2\r\nline3 | pipe \\ backslash");
    assert_eq!(rows[3]["note"], "");
    assert_eq!(rows[4]["note"], serde_json::Value::Null);
    assert_eq!(rows[0]["doc"]["a"][1], 2);
    assert_eq!(rows[5]["note"], "unicode: é 漢字 🙂");
}

/// SQL INSERT output runs against the server and reproduces the rows exactly.
#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn sql_insert_copy_runs_and_reproduces_the_rows() {
    let s = PostgresAdapter
        .connect(&params(), Box::new(|_| {}))
        .await
        .expect("connect");
    tricky_table(&s, "it_copy_sql").await;
    let (columns, cursor) = query(&s, "select * from public.it_copy_sql order by id").await;
    let rows = all_rows(&s, &cursor).await;
    let options = WriteOptions {
        table: Some(TableName {
            schema: "public".into(),
            name: "it_copy_sql_target".into(),
        }),
        ..WriteOptions::default()
    };
    // One statement per row, as the script lists them.
    let statements: Vec<String> = rows
        .iter()
        .map(|r| {
            let text = format_rows(
                Format::SqlInsert,
                &columns,
                std::slice::from_ref(r),
                &options,
            )
            .expect("sql");
            text.trim_end().trim_end_matches(';').to_owned()
        })
        .collect();
    let script = format_rows(Format::SqlInsert, &columns, &rows, &options).expect("script");
    assert_eq!(script.matches("INSERT INTO").count(), 6);
    s.apply_schema(&statements).await.expect("insert copies");
    let (_, diff) = query(
        &s,
        "select count(*)::text from ((select * from public.it_copy_sql except all select * from public.it_copy_sql_target) \
         union all (select * from public.it_copy_sql_target except all select * from public.it_copy_sql)) d",
    )
    .await;
    let n = all_rows(&s, &diff).await;
    assert_eq!(n[0][0].as_deref(), Some("0"), "{script}");
}

/// Open data runs the user's WHERE text inside a SELECT; on a read-only source the server still
/// rejects anything that writes, such as `nextval()`.
#[tokio::test]
#[ignore = "needs scripts/test-pg.sh up"]
async fn browse_where_text_cannot_write_on_a_read_only_source() {
    let rw = PostgresAdapter
        .connect(&params(), Box::new(|_| {}))
        .await
        .expect("connect");
    rw.apply_schema(&[
        "drop table if exists public.it_browse".into(),
        "drop sequence if exists public.it_browse_seq".into(),
        "create sequence public.it_browse_seq".into(),
        "create table public.it_browse (id int primary key)".into(),
        "insert into public.it_browse values (1), (2)".into(),
    ])
    .await
    .expect("fixture");
    let ro = PostgresAdapter
        .connect(
            &ConnectParams {
                read_only: true,
                ..params()
            },
            Box::new(|_| {}),
        )
        .await
        .expect("connect");
    // The statement the Open data bar builds from the WHERE and ORDER BY text.
    let browse = |filter: &str| {
        format!("SELECT * FROM \"public\".\"it_browse\" WHERE ({filter}) ORDER BY id DESC")
    };
    let ok = ro
        .execute(&browse("id > 1"), &ExecOptions::default())
        .await
        .expect("read");
    assert!(
        matches!(ok, StatementOutcome::Rows { total_rows: 1, .. }),
        "{ok:?}"
    );
    let e = ro
        .execute(
            &browse("nextval('public.it_browse_seq') > 0"),
            &ExecOptions::default(),
        )
        .await
        .expect_err("write function");
    assert_eq!(e.sqlstate.as_deref(), Some("25006"), "{e:?}");
    let e = ro
        .execute(
            &browse("1 = 1); delete from public.it_browse where (true"),
            &ExecOptions::default(),
        )
        .await
        .expect_err("second statement");
    assert!(e.sqlstate.is_some(), "{e:?}");
    let (_, cursor) = query(&rw, "select count(*)::text from public.it_browse").await;
    assert_eq!(all_rows(&rw, &cursor).await[0][0].as_deref(), Some("2"));
}
