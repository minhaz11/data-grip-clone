//! Application logging (ADR-0003): `tracing` events go to a size-capped file in the app's log
//! directory, and every event is passed through [`redact`] before it is written.
//!
//! Log what happened (ids, hosts, counts, durations, error kinds), never row data. SQL text is not
//! logged.

mod file;
mod redact;

use std::io::{self, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::MakeWriter;

pub use file::RotatingFile;
pub use redact::{MASK, redact};

/// Name of the current log file inside the log directory.
pub const LOG_FILE: &str = "quarry.log";
const MAX_BYTES: u64 = 5 * 1024 * 1024;
const KEEP: u32 = 3;
/// Overrides the default filter, e.g. `QUARRY_LOG=debug` or `QUARRY_LOG=quarry_desktop=trace`.
pub const FILTER_ENV: &str = "QUARRY_LOG";
const DEFAULT_FILTER: &str = "info,tokio_postgres=warn,rustls=warn,tao=warn,wry=warn";

/// Writes redacted events to a shared [`RotatingFile`], and optionally to stderr.
#[derive(Clone)]
pub struct RedactingWriter {
    file: Arc<Mutex<RotatingFile>>,
    stderr: bool,
}

impl RedactingWriter {
    pub fn new(file: RotatingFile, stderr: bool) -> Self {
        Self {
            file: Arc::new(Mutex::new(file)),
            stderr,
        }
    }
}

/// Collects one formatted event, then redacts and writes it as a whole when dropped, so a secret
/// split across several `write` calls is still seen in one piece.
pub struct EventWriter {
    target: RedactingWriter,
    buf: Vec<u8>,
}

impl Write for EventWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for EventWriter {
    fn drop(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        let text = String::from_utf8_lossy(&self.buf);
        let clean = redact(&text);
        if let Ok(mut file) = self.target.file.lock() {
            // Logging must never take the app down; a failed write is dropped.
            let _ = file.write_record(clean.as_bytes());
        }
        if self.target.stderr {
            let _ = io::stderr().write_all(clean.as_bytes());
        }
    }
}

impl<'a> MakeWriter<'a> for RedactingWriter {
    type Writer = EventWriter;

    fn make_writer(&'a self) -> Self::Writer {
        EventWriter {
            target: self.clone(),
            buf: Vec::new(),
        }
    }
}

/// Builds the subscriber used by the app (and by tests that check what reaches the log file).
pub fn subscriber(
    writer: RedactingWriter,
    filter: EnvFilter,
) -> impl tracing::Subscriber + Send + Sync {
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(writer)
        .with_ansi(false)
        .with_target(true)
        .finish()
}

/// Installs the global subscriber, logging to `<dir>/quarry.log` (and stderr when `stderr` is
/// set, e.g. in development). Fails if the directory cannot be created or the file opened.
pub fn init(dir: &Path, stderr: bool) -> io::Result<()> {
    let file = RotatingFile::open(dir, LOG_FILE, MAX_BYTES, KEEP)?;
    let filter =
        EnvFilter::try_from_env(FILTER_ENV).unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));
    // A second init (tests, re-entrant setup) keeps the first subscriber.
    let _ = tracing::subscriber::set_global_default(subscriber(
        RedactingWriter::new(file, stderr),
        filter,
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_are_redacted_before_reaching_the_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = RotatingFile::open(dir.path(), LOG_FILE, MAX_BYTES, KEEP).expect("open");
        let sub = subscriber(RedactingWriter::new(file, false), EnvFilter::new("info"));
        tracing::subscriber::with_default(sub, || {
            tracing::info!(
                host = "db.local",
                password = "Canary-Secret-42",
                "connecting"
            );
            tracing::warn!("driver said: postgres://alice:Canary-Secret-42@db.local/app refused");
            tracing::info!(key = ?"sk-ant-api03-Canary-Secret-42", "ai request");
        });
        let text = std::fs::read_to_string(dir.path().join(LOG_FILE)).expect("read");
        assert!(
            !text.contains("Canary-Secret-42"),
            "secret reached the log:\n{text}"
        );
        assert!(
            text.contains("connecting") && text.contains("host=\"db.local\""),
            "{text}"
        );
        assert_eq!(text.lines().count(), 3, "{text}");
    }
}
