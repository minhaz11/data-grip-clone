//! Soak run (Phase 7): a large result is paged, sorted, filtered and exported over and over, and
//! the process's resident memory is sampled after each round. Ignored by default; run it with
//! `scripts/soak.sh` (or `cargo test -p quarry-db-postgres --release --test soak_pg -- --ignored
//! --nocapture`) against `scripts/test-pg.sh up`.
//!
//! - `QUARRY_SOAK_MINUTES` (default 2): how long to keep going.
//! - `QUARRY_SOAK_ROWS` (default 1,000,000): rows in the result.
//!
//! It fails when memory keeps growing: after the first rounds have warmed up, resident memory
//! may not rise by more than 64 MB.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use quarry_db_core::{
    ConnectParams, DatabaseAdapter, ExecOptions, Filter, FilterOp, Refinement, Session, SortKey,
    StatementOutcome, TlsMode,
};
use quarry_db_postgres::PostgresAdapter;
use quarry_io::{ExportOutcome, Format, WriteOptions, export_to_file};
use quarry_secrets::SecretString;

const WARMUP_ROUNDS: usize = 2;
const MAX_GROWTH_BYTES: u64 = 64 << 20;
const PAGE: usize = 500;

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
        application_name: "quarry-soak".into(),
        options: Default::default(),
    }
}

fn env_number(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.replace(['_', ','], "").parse().ok())
        .unwrap_or(default)
}

fn rss() -> u64 {
    memory_stats::memory_stats().map_or(0, |m| m.physical_mem as u64)
}

fn mb(bytes: u64) -> f64 {
    bytes as f64 / (1 << 20) as f64
}

fn cursor_of(outcome: StatementOutcome) -> (Vec<quarry_db_core::ColumnInfo>, String, u64) {
    match outcome {
        StatementOutcome::Rows {
            columns,
            cursor,
            total_rows,
            ..
        } => (columns, cursor.expect("cursor-backed result"), total_rows),
        other => panic!("expected rows, got {other:?}"),
    }
}

/// Pages through `cursor` the way scrolling does (start, middle, end, and some jumps); returns
/// the mean time per page.
async fn scroll(s: &Arc<dyn Session>, cursor: &str, total: u64) -> Duration {
    let opts = ExecOptions::default();
    let mut offsets: Vec<u64> = (0..20).map(|i| i * PAGE as u64).collect();
    for f in [0.25, 0.5, 0.75, 0.999] {
        offsets.push(((total as f64 * f) as u64).saturating_sub(PAGE as u64));
    }
    let started = Instant::now();
    for &offset in &offsets {
        let page = s.fetch(cursor, offset, PAGE, &opts).await.expect("page");
        assert!(!page.is_empty() || offset >= total);
    }
    started.elapsed() / offsets.len() as u32
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "soak run: needs scripts/test-pg.sh up; see scripts/soak.sh"]
async fn large_results_do_not_grow_memory() {
    let minutes = env_number("QUARRY_SOAK_MINUTES", 2);
    let rows = env_number("QUARRY_SOAK_ROWS", 1_000_000);
    let sql = format!(
        "select g as id, md5(g::text) as hash, (g % 1000) as bucket, now() - g * interval '1 second' as at \
         from generate_series(1, {rows}) g"
    );
    let s = PostgresAdapter
        .connect(&params(), Box::new(|_| {}))
        .await
        .expect("connect");
    let dir = tempfile::tempdir().expect("tempdir");
    let deadline = Instant::now() + Duration::from_secs(minutes * 60);
    let mut baseline = None;
    let mut peak = 0;
    let mut round = 0;
    println!("round  rss_mb  page_ms  sorted_page_ms  filtered_rows  export_s");
    while Instant::now() < deadline || round < WARMUP_ROUNDS + 1 {
        round += 1;
        let (columns, cursor, total) = cursor_of(
            s.execute(&sql, &ExecOptions::default())
                .await
                .expect("query"),
        );
        let page_time = scroll(&s, &cursor, total).await;

        let sorted = s
            .refine(
                &sql,
                &columns,
                &Refinement {
                    sort: vec![SortKey {
                        column: 1,
                        descending: true,
                    }],
                    filters: Vec::new(),
                },
                &ExecOptions::default(),
            )
            .await
            .expect("sort");
        let (_, sorted_cursor, sorted_total) = cursor_of(sorted);
        let sorted_time = scroll(&s, &sorted_cursor, sorted_total).await;
        s.close_cursor(&sorted_cursor).await.expect("close sorted");

        let filtered = s
            .refine(
                &sql,
                &columns,
                &Refinement {
                    sort: Vec::new(),
                    filters: vec![Filter {
                        column: 2,
                        op: FilterOp::Eq,
                        value: Some("7".into()),
                    }],
                },
                &ExecOptions::default(),
            )
            .await
            .expect("filter");
        let (_, filtered_cursor, filtered_total) = cursor_of(filtered);
        s.close_cursor(&filtered_cursor)
            .await
            .expect("close filtered");

        let path = dir.path().join("soak.csv");
        let export_started = Instant::now();
        let done = export_to_file(
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
        assert!(matches!(done, ExportOutcome::Written { rows: r, .. } if r == total));
        let export_time = export_started.elapsed();
        std::fs::remove_file(&path).expect("remove export");
        s.close_cursor(&cursor).await.expect("close");

        let now = rss();
        peak = peak.max(now);
        if round == WARMUP_ROUNDS {
            baseline = Some(now);
        }
        println!(
            "{round:>5}  {:>6.1}  {:>7.2}  {:>14.2}  {filtered_total:>13}  {:>8.1}",
            mb(now),
            page_time.as_secs_f64() * 1000.0,
            sorted_time.as_secs_f64() * 1000.0,
            export_time.as_secs_f64(),
        );
    }
    let baseline = baseline.expect("warmed up");
    println!(
        "rounds {round}, rows {rows}, rss after warm-up {:.1} MB, peak {:.1} MB",
        mb(baseline),
        mb(peak)
    );
    assert!(
        peak.saturating_sub(baseline) <= MAX_GROWTH_BYTES,
        "resident memory grew from {:.1} MB to {:.1} MB",
        mb(baseline),
        mb(peak)
    );
    s.close().await;
}
