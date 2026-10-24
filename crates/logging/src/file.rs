//! A log file that rotates by size: `quarry.log`, then `quarry.log.1` ... `quarry.log.<keep>`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub struct RotatingFile {
    path: PathBuf,
    max_bytes: u64,
    keep: u32,
    file: File,
    size: u64,
}

impl RotatingFile {
    /// Opens (appending to) `dir/name`, creating `dir` if needed.
    pub fn open(dir: &Path, name: &str, max_bytes: u64, keep: u32) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let path = dir.join(name);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let size = file.metadata()?.len();
        Ok(Self {
            path,
            max_bytes,
            keep,
            file,
            size,
        })
    }

    fn rotated(&self, n: u32) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(format!(".{n}"));
        PathBuf::from(name)
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file.flush()?;
        if self.keep == 0 {
            self.file = File::create(&self.path)?;
        } else {
            let _ = fs::remove_file(self.rotated(self.keep));
            for n in (1..self.keep).rev() {
                let from = self.rotated(n);
                if from.exists() {
                    fs::rename(&from, self.rotated(n + 1))?;
                }
            }
            fs::rename(&self.path, self.rotated(1))?;
            self.file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;
        }
        self.size = 0;
        Ok(())
    }

    /// Writes one whole record; rotates first if it would push the file past `max_bytes`.
    pub fn write_record(&mut self, record: &[u8]) -> io::Result<()> {
        if self.size > 0 && self.size + record.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        self.file.write_all(record)?;
        self.size += record.len() as u64;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_by_size_and_keeps_a_bounded_number_of_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut log = RotatingFile::open(dir.path(), "quarry.log", 100, 2).expect("open");
        for i in 0..20 {
            log.write_record(format!("record {i:02} {}\n", "x".repeat(30)).as_bytes())
                .expect("write");
        }
        let mut names: Vec<String> = fs::read_dir(dir.path())
            .expect("read_dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, ["quarry.log", "quarry.log.1", "quarry.log.2"]);
        for name in &names {
            let len = fs::metadata(dir.path().join(name)).expect("meta").len();
            assert!(len <= 100, "{name} is {len} bytes");
        }
        let current = fs::read_to_string(dir.path().join("quarry.log")).expect("read");
        assert!(
            current.contains("record 19"),
            "newest record is in the current file"
        );
    }

    #[test]
    fn appends_across_reopen() {
        let dir = tempfile::tempdir().expect("tempdir");
        RotatingFile::open(dir.path(), "a.log", 1_000, 1)
            .and_then(|mut f| f.write_record(b"one\n"))
            .expect("first");
        RotatingFile::open(dir.path(), "a.log", 1_000, 1)
            .and_then(|mut f| f.write_record(b"two\n"))
            .expect("second");
        let text = fs::read_to_string(dir.path().join("a.log")).expect("read");
        assert_eq!(text, "one\ntwo\n");
    }
}
