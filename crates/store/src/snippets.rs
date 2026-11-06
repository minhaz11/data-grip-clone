//! User snippets (M5.5): an abbreviation that expands into a SQL template. Bodies use Monaco
//! snippet syntax (`${1:name}`, `$0`; a literal `$` is written `\$`).

use rusqlite::{ErrorCode, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

/// Which data sources a snippet is offered for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SnippetDialect {
    Postgresql,
    /// Every engine.
    Any,
}

impl SnippetDialect {
    fn as_str(self) -> &'static str {
        match self {
            Self::Postgresql => "postgresql",
            Self::Any => "any",
        }
    }

    fn parse(s: &str) -> Result<Self, StoreError> {
        match s {
            "postgresql" => Ok(Self::Postgresql),
            "any" => Ok(Self::Any),
            other => Err(StoreError::Invalid(format!("unknown dialect '{other}'"))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SnippetDraft {
    /// What is typed before Tab: letters, digits and `_`.
    pub abbreviation: String,
    pub description: String,
    pub body: String,
    pub dialect: SnippetDialect,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    #[serde(flatten)]
    pub draft: SnippetDraft,
    pub created_at: String,
    pub updated_at: String,
}

/// The export file: user snippets without ids or times.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SnippetFile {
    /// Always `quarry-snippets`.
    pub format: String,
    pub version: u32,
    pub snippets: Vec<SnippetDraft>,
}

pub const SNIPPET_FORMAT: &str = "quarry-snippets";
pub const BODY_MAX: usize = 64 * 1024;
/// At most this many snippets in one import.
pub const IMPORT_MAX: usize = 5_000;

impl SnippetDraft {
    pub fn normalized(mut self) -> Result<Self, StoreError> {
        let invalid = |m: &str| Err(StoreError::Invalid(m.to_owned()));
        self.abbreviation = self.abbreviation.trim().to_owned();
        self.description = self.description.trim().to_owned();
        let a = &self.abbreviation;
        if a.is_empty()
            || a.len() > 40
            || !a.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || a.starts_with(|c: char| c.is_ascii_digit())
        {
            return invalid(
                "The abbreviation is 1 to 40 letters, digits or _, starting with a letter or _.",
            );
        }
        if self.description.chars().count() > 200 {
            return invalid("The description is at most 200 characters.");
        }
        if self.body.trim().is_empty() || self.body.len() > BODY_MAX {
            return invalid("The template is required (at most 64 KB).");
        }
        Ok(self)
    }
}

const COLUMNS: &str = "id, abbreviation, description, body, dialect, created_at, updated_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Result<Snippet, StoreError>> {
    let text = |i: usize| row.get::<_, String>(i);
    let parsed = (|| -> Result<Snippet, StoreError> {
        Ok(Snippet {
            id: text(0)?,
            draft: SnippetDraft {
                abbreviation: text(1)?,
                description: text(2)?,
                body: text(3)?,
                dialect: SnippetDialect::parse(&text(4)?)?,
            },
            created_at: text(5)?,
            updated_at: text(6)?,
        })
    })();
    Ok(parsed)
}

fn map_unique(err: rusqlite::Error, d: &SnippetDraft) -> StoreError {
    match &err {
        rusqlite::Error::SqliteFailure(e, _) if e.code == ErrorCode::ConstraintViolation => {
            StoreError::Invalid(format!(
                "A snippet \"{}\" already exists for {}.",
                d.abbreviation,
                match d.dialect {
                    SnippetDialect::Postgresql => "PostgreSQL",
                    SnippetDialect::Any => "every data source",
                }
            ))
        }
        _ => StoreError::Sqlite(err),
    }
}

impl Store {
    pub fn list_snippets(&self) -> Result<Vec<Snippet>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM snippets ORDER BY abbreviation COLLATE NOCASE, dialect"
        ))?;
        let rows = stmt.query_map([], from_row)?;
        rows.map(|r| r?).collect()
    }

    fn snippet(&self, id: &str) -> Result<Option<Snippet>, StoreError> {
        self.conn()
            .query_row(
                &format!("SELECT {COLUMNS} FROM snippets WHERE id = ?1"),
                [id],
                from_row,
            )
            .optional()?
            .transpose()
    }

    pub fn insert_snippet(&self, id: &str, draft: SnippetDraft) -> Result<Snippet, StoreError> {
        let d = draft.normalized()?;
        self.conn()
            .execute(
                "INSERT INTO snippets (id, abbreviation, description, body, dialect)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    id,
                    d.abbreviation,
                    d.description,
                    d.body,
                    d.dialect.as_str()
                ],
            )
            .map_err(|e| map_unique(e, &d))?;
        self.snippet(id)?
            .ok_or_else(|| StoreError::NotFound(format!("snippet {id}")))
    }

    pub fn update_snippet(&self, id: &str, draft: SnippetDraft) -> Result<Snippet, StoreError> {
        let d = draft.normalized()?;
        let changed = self
            .conn()
            .execute(
                "UPDATE snippets SET abbreviation = ?2, description = ?3, body = ?4, dialect = ?5,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE id = ?1",
                params![
                    id,
                    d.abbreviation,
                    d.description,
                    d.body,
                    d.dialect.as_str()
                ],
            )
            .map_err(|e| map_unique(e, &d))?;
        if changed == 0 {
            return Err(StoreError::NotFound(format!("snippet {id}")));
        }
        self.snippet(id)?
            .ok_or_else(|| StoreError::NotFound(format!("snippet {id}")))
    }

    pub fn delete_snippet(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self
            .conn()
            .execute("DELETE FROM snippets WHERE id = ?1", [id])?
            > 0)
    }

    /// Adds snippets from an export file; one with the same abbreviation and dialect is
    /// replaced. All or nothing. Returns (added, replaced).
    pub fn import_snippets(
        &self,
        file: SnippetFile,
        new_id: &mut dyn FnMut() -> String,
    ) -> Result<(usize, usize), StoreError> {
        if file.format != SNIPPET_FORMAT || file.version != 1 {
            return Err(StoreError::Invalid(
                "This is not a Quarry snippets file (version 1).".into(),
            ));
        }
        if file.snippets.len() > IMPORT_MAX {
            return Err(StoreError::Invalid(format!(
                "At most {IMPORT_MAX} snippets can be imported at once."
            )));
        }
        let drafts = file
            .snippets
            .into_iter()
            .map(SnippetDraft::normalized)
            .collect::<Result<Vec<_>, _>>()?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let (mut added, mut replaced) = (0, 0);
        for d in drafts {
            let changed = tx.execute(
                "UPDATE snippets SET description = ?3, body = ?4,
                     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                 WHERE abbreviation = ?1 COLLATE NOCASE AND dialect = ?2",
                params![d.abbreviation, d.dialect.as_str(), d.description, d.body],
            )?;
            if changed > 0 {
                replaced += 1;
            } else {
                tx.execute(
                    "INSERT INTO snippets (id, abbreviation, description, body, dialect)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        new_id(),
                        d.abbreviation,
                        d.description,
                        d.body,
                        d.dialect.as_str()
                    ],
                )
                .map_err(|e| map_unique(e, &d))?;
                added += 1;
            }
        }
        tx.commit()?;
        Ok((added, replaced))
    }

    /// Every user snippet as an export file.
    pub fn export_snippets(&self) -> Result<SnippetFile, StoreError> {
        Ok(SnippetFile {
            format: SNIPPET_FORMAT.into(),
            version: 1,
            snippets: self.list_snippets()?.into_iter().map(|s| s.draft).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(abbreviation: &str, body: &str) -> SnippetDraft {
        SnippetDraft {
            abbreviation: abbreviation.into(),
            description: "test".into(),
            body: body.into(),
            dialect: SnippetDialect::Postgresql,
        }
    }

    #[test]
    fn crud_and_validation() {
        let store = Store::open_in_memory().expect("open");
        let s = store
            .insert_snippet(
                "1",
                draft(" fn ", "CREATE FUNCTION ${1:name}() AS \\$\\$ \\$1 \\$\\$"),
            )
            .expect("insert");
        assert_eq!(s.draft.abbreviation, "fn");
        let dup = store
            .insert_snippet("2", draft("FN", "x"))
            .expect_err("dup");
        assert!(dup.to_string().contains("already exists"), "{dup}");
        // The same abbreviation for another dialect is fine.
        store
            .insert_snippet(
                "3",
                SnippetDraft {
                    dialect: SnippetDialect::Any,
                    ..draft("fn", "x")
                },
            )
            .expect("other dialect");
        for bad in ["", "two words", "1st", &"a".repeat(41)] {
            assert!(
                store.insert_snippet("x", draft(bad, "x")).is_err(),
                "{bad:?}"
            );
        }
        assert!(store.insert_snippet("x", draft("empty", "  ")).is_err());
        let updated = store
            .update_snippet("1", draft("fn2", "select 1"))
            .expect("update");
        assert_eq!(updated.draft.body, "select 1");
        assert!(store.delete_snippet("1").expect("delete"));
        assert_eq!(store.list_snippets().expect("list").len(), 1);
    }

    #[test]
    fn export_then_import_on_a_fresh_profile_restores_the_same_snippets() {
        let a = Store::open_in_memory().expect("open");
        a.insert_snippet("1", draft("sel", "SELECT ${1:*} FROM ${2:table}$0"))
            .expect("1");
        a.insert_snippet("2", draft("dollar", "DO \\$\\$ BEGIN \\$1; END \\$\\$"))
            .expect("2");
        let file = a.export_snippets().expect("export");
        let json = serde_json::to_string(&file).expect("json");

        let b = Store::open_in_memory().expect("fresh");
        let mut n = 0;
        let mut ids = || {
            n += 1;
            format!("id{n}")
        };
        let back: SnippetFile = serde_json::from_str(&json).expect("parse");
        assert_eq!(
            b.import_snippets(back.clone(), &mut ids).expect("import"),
            (2, 0)
        );
        let restored: Vec<SnippetDraft> = b
            .list_snippets()
            .expect("list")
            .into_iter()
            .map(|s| s.draft)
            .collect();
        assert_eq!(restored, file.snippets);
        // Importing again replaces rather than duplicates.
        assert_eq!(b.import_snippets(back, &mut ids).expect("again"), (0, 2));

        let wrong = SnippetFile {
            format: "other".into(),
            version: 1,
            snippets: vec![],
        };
        assert!(b.import_snippets(wrong, &mut ids).is_err());
    }
}
