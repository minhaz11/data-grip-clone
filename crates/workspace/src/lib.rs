//! Query consoles as plain `.sql` files in one directory (ADR-0004). Callers address consoles by
//! *name*; names are validated so no input can escape the directory.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

pub const MAX_CONSOLE_BYTES: usize = 16 * 1024 * 1024;
const EXT: &str = "sql";

#[derive(Debug, thiserror::Error)]
pub enum ConsoleError {
    #[error("invalid console name \"{0}\": use letters, digits, spaces, '.', '-' or '_' (max 100)")]
    InvalidName(String),
    #[error("console \"{0}\" does not exist")]
    NotFound(String),
    #[error("console is {0} bytes; the limit is {MAX_CONSOLE_BYTES}")]
    TooLarge(usize),
    #[error("console file error: {0}")]
    Io(#[from] io::Error),
}

pub struct Consoles {
    dir: PathBuf,
}

impl Consoles {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Creates an empty console with the lowest free name: `console`, `console_1`, `console_2`, ...
    /// (or `preferred` when given and free). Uses create-new semantics, so concurrent callers never
    /// get the same file.
    pub fn create(&self, preferred: Option<&str>) -> Result<String, ConsoleError> {
        fs::create_dir_all(&self.dir)?;
        if let Some(name) = preferred {
            validate(name)?;
            if self.try_create(name)? {
                return Ok(name.to_owned());
            }
        }
        for i in 0.. {
            let name = if i == 0 {
                "console".to_owned()
            } else {
                format!("console_{i}")
            };
            if self.try_create(&name)? {
                return Ok(name);
            }
        }
        unreachable!("an unbounded range always yields a free name")
    }

    pub fn read(&self, name: &str) -> Result<String, ConsoleError> {
        match fs::read_to_string(self.path(name)?) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                Err(ConsoleError::NotFound(name.to_owned()))
            }
            other => Ok(other?),
        }
    }

    /// Atomic replace: write a temp file next to the target, then rename over it.
    pub fn write(&self, name: &str, text: &str) -> Result<(), ConsoleError> {
        if text.len() > MAX_CONSOLE_BYTES {
            return Err(ConsoleError::TooLarge(text.len()));
        }
        let path = self.path(name)?;
        if !path.exists() {
            return Err(ConsoleError::NotFound(name.to_owned()));
        }
        let tmp = self.dir.join(format!(".{name}.{EXT}.tmp"));
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(text.as_bytes())?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<String>, ConsoleError> {
        let entries = match fs::read_dir(&self.dir) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            other => other?,
        };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|e| {
                let p = e.path();
                (p.extension()? == EXT).then(|| p.file_stem()?.to_str().map(str::to_owned))?
            })
            .filter(|n| validate(n).is_ok())
            .collect();
        names.sort();
        Ok(names)
    }

    fn try_create(&self, name: &str) -> Result<bool, ConsoleError> {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.path(name)?)
        {
            Ok(_) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e.into()),
        }
    }

    fn path(&self, name: &str) -> Result<PathBuf, ConsoleError> {
        validate(name)?;
        Ok(self.dir.join(format!("{name}.{EXT}")))
    }
}

/// Allows `console_2`, `orders report`, `v1.2-draft`; rejects separators, `..`, hidden names.
fn validate(name: &str) -> Result<(), ConsoleError> {
    let ok = !name.is_empty()
        && name.chars().count() <= 100
        && !name.starts_with(['.', ' '])
        && !name.ends_with([' ', '.'])
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | ' '));
    if ok {
        Ok(())
    } else {
        Err(ConsoleError::InvalidName(name.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn consoles() -> (tempfile::TempDir, Consoles) {
        let dir = tempfile::tempdir().expect("tempdir");
        let c = Consoles::new(dir.path().join("consoles"));
        (dir, c)
    }

    #[test]
    fn creates_lowest_free_names_and_honours_preferred() {
        let (_d, c) = consoles();
        assert_eq!(c.create(None).expect("1"), "console");
        assert_eq!(c.create(None).expect("2"), "console_1");
        assert_eq!(c.create(Some("report")).expect("3"), "report");
        assert_eq!(
            c.create(Some("report")).expect("4"),
            "console_2",
            "taken preferred falls back"
        );
        fs::remove_file(c.dir().join("console.sql")).expect("rm");
        assert_eq!(c.create(None).expect("5"), "console");
        assert_eq!(
            c.list().expect("list"),
            ["console", "console_1", "console_2", "report"]
        );
    }

    #[test]
    fn write_read_round_trip_is_atomic_and_bounded() {
        let (_d, c) = consoles();
        let name = c.create(None).expect("create");
        assert_eq!(c.read(&name).expect("read"), "");
        c.write(&name, "select 1;\nselect 'ünïcode';")
            .expect("write");
        assert_eq!(c.read(&name).expect("read"), "select 1;\nselect 'ünïcode';");
        assert!(
            !c.dir().join(".console.sql.tmp").exists(),
            "temp file renamed away"
        );
        let big = "x".repeat(MAX_CONSOLE_BYTES + 1);
        assert!(matches!(
            c.write(&name, &big),
            Err(ConsoleError::TooLarge(_))
        ));
        assert!(matches!(
            c.write("ghost", "x"),
            Err(ConsoleError::NotFound(_))
        ));
        assert!(matches!(c.read("ghost"), Err(ConsoleError::NotFound(_))));
    }

    #[test]
    fn rejects_names_that_could_escape_or_hide() {
        let (_d, c) = consoles();
        for bad in [
            "",
            "../etc/passwd",
            "a/b",
            "a\\b",
            "..",
            ".hidden",
            "x..y",
            "name ",
            "a\0b",
            "tab\t",
        ] {
            assert!(
                matches!(c.read(bad), Err(ConsoleError::InvalidName(_))),
                "{bad:?}"
            );
            assert!(
                matches!(c.create(Some(bad)), Err(ConsoleError::InvalidName(_))),
                "{bad:?}"
            );
        }
        assert!(validate("orders report v1.2-draft_3").is_ok());
    }

    #[test]
    fn list_ignores_foreign_files() {
        let (_d, c) = consoles();
        c.create(None).expect("create");
        fs::write(c.dir().join("notes.txt"), "x").expect("txt");
        fs::write(c.dir().join(".console.sql.tmp"), "x").expect("tmp");
        assert_eq!(c.list().expect("list"), ["console"]);
    }
}
