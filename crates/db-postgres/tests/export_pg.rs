//! Export path end to end: cursor pages → quarry-io writer → file, as `result_export` does.

use std::io::BufWriter;
use std::sync::Arc;
use std::time::Duration;

use quarry_db_core::{
    ConnectParams, DatabaseAdapter, ExecOptions, Session, StatementOutcome, TlsMode,
};
use quarry_db_postgres::PostgresAdapter;
use quarry_io::{ExportWriter, Format};
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
    let mut w = ExportWriter::new(BufWriter::new(file), format, &columns).expect("writer");
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
