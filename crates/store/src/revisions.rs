//! Local history of console files (M5.2): earlier versions of a console's text, so an overwrite
//! or a deletion is never final. Revisions are taken sparingly (not per autosave) and pruned by
//! count per console and by age.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::{Store, StoreError};

/// Why a revision was taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum RevisionReason {
    /// While editing, at most once per interval.
    Auto,
    /// The text before a save that removed most of it.
    BeforeDeletion,
    /// The file as changed outside the app, before the app overwrote it.
    External,
    BeforeRun,
    BeforeFormat,
    /// The text a restore replaced.
    BeforeRestore,
    /// The last text of a deleted console.
    BeforeDelete,
}

impl RevisionReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::BeforeDeletion => "beforeDeletion",
            Self::External => "external",
            Self::BeforeRun => "beforeRun",
            Self::BeforeFormat => "beforeFormat",
            Self::BeforeRestore => "beforeRestore",
            Self::BeforeDelete => "beforeDelete",
        }
    }

    fn parse(s: &str) -> Result<Self, StoreError> {
        Ok(match s {
            "auto" => Self::Auto,
            "beforeDeletion" => Self::BeforeDeletion,
            "external" => Self::External,
            "beforeRun" => Self::BeforeRun,
            "beforeFormat" => Self::BeforeFormat,
            "beforeRestore" => Self::BeforeRestore,
            "beforeDelete" => Self::BeforeDelete,
            other => {
                return Err(StoreError::Invalid(format!(
                    "unknown revision reason '{other}'"
                )));
            }
        })
    }
}

/// A revision in the history list (without its text).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RevisionInfo {
    pub id: i64,
    /// Unix time in milliseconds.
    pub created_at: i64,
    pub reason: RevisionReason,
    /// Bytes of text.
    pub size: u64,
    /// The first non-blank line, for recognizing a revision in the list.
    pub first_line: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RevisionRetention {
    pub max_per_console: u32,
    /// 0 keeps revisions regardless of age.
    pub max_age_days: u32,
    /// Minimum time between `Auto` revisions.
    pub interval_ms: i64,
}

/// What a save should record first, if anything: the text it replaces (`previous`), when the
/// save removes most of it, when the file changed outside the app (`external`), or when the last
/// revision is older than the interval. Blank text is never worth a revision.
pub fn before_save(
    previous: &str,
    next: &str,
    external: bool,
    last_revision_at: Option<i64>,
    now: i64,
    interval_ms: i64,
) -> Option<RevisionReason> {
    if previous.trim().is_empty() || previous == next {
        return None;
    }
    if external {
        return Some(RevisionReason::External);
    }
    if next.trim().len() * 2 < previous.trim().len() {
        return Some(RevisionReason::BeforeDeletion);
    }
    match last_revision_at {
        Some(at) if now - at < interval_ms => None,
        _ => Some(RevisionReason::Auto),
    }
}

impl Store {
    /// Records `text` as a revision of `console`, unless it is blank or equals the latest
    /// revision; then prunes. Returns the new revision's id.
    pub fn add_revision(
        &self,
        console: &str,
        reason: RevisionReason,
        text: &str,
        now: i64,
        retention: RevisionRetention,
    ) -> Result<Option<i64>, StoreError> {
        if text.trim().is_empty() {
            return Ok(None);
        }
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let latest: Option<String> = tx
            .query_row(
                "SELECT text FROM console_revisions WHERE console = ?1 ORDER BY id DESC LIMIT 1",
                [console],
                |r| r.get(0),
            )
            .optional()?;
        if latest.as_deref() == Some(text) {
            return Ok(None);
        }
        tx.execute(
            "INSERT INTO console_revisions (console, created_at, reason, text, size)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![console, now, reason.as_str(), text, text.len() as i64],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "DELETE FROM console_revisions WHERE console = ?1 AND id NOT IN (
                 SELECT id FROM console_revisions WHERE console = ?1 ORDER BY id DESC LIMIT ?2)",
            params![console, retention.max_per_console],
        )?;
        if retention.max_age_days > 0 {
            let cutoff = now - i64::from(retention.max_age_days) * 86_400_000;
            tx.execute(
                "DELETE FROM console_revisions WHERE created_at < ?1",
                [cutoff],
            )?;
        }
        tx.commit()?;
        Ok(Some(id))
    }

    /// When `console`'s latest revision was taken.
    pub fn latest_revision_at(&self, console: &str) -> Result<Option<i64>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT max(created_at) FROM console_revisions WHERE console = ?1",
                [console],
                |r| r.get(0),
            )
            .optional()?
            .flatten())
    }

    /// Revisions of `console`, newest first.
    pub fn list_revisions(&self, console: &str) -> Result<Vec<RevisionInfo>, StoreError> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, created_at, reason, size, text FROM console_revisions
             WHERE console = ?1 ORDER BY id DESC",
        )?;
        let rows = stmt.query_map([console], |r| {
            let text: String = r.get(4)?;
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                text,
            ))
        })?;
        rows.map(|row| {
            let (id, created_at, reason, size, text) = row?;
            let first_line = text
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .unwrap_or("")
                .chars()
                .take(120)
                .collect();
            Ok(RevisionInfo {
                id,
                created_at,
                reason: RevisionReason::parse(&reason)?,
                size: u64::try_from(size).unwrap_or(0),
                first_line,
            })
        })
        .collect()
    }

    /// A revision's console and text.
    pub fn revision(&self, id: i64) -> Result<Option<(String, String)>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT console, text FROM console_revisions WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }

    /// Moves a console's revisions to its new name.
    pub fn rename_revisions(&self, from: &str, to: &str) -> Result<(), StoreError> {
        self.conn().execute(
            "UPDATE console_revisions SET console = ?2 WHERE console = ?1",
            params![from, to],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEEP: RevisionRetention = RevisionRetention {
        max_per_console: 3,
        max_age_days: 0,
        interval_ms: 5 * 60_000,
    };

    #[test]
    fn autosave_bursts_create_one_revision() {
        let store = Store::open_in_memory().expect("open");
        let mut text = String::from("select 1");
        let mut now = 1_000_000;
        // A hundred saves 400 ms apart, each adding a character.
        for i in 0..100 {
            let next = format!("{text}{}", i % 10);
            if let Some(reason) = before_save(
                &text,
                &next,
                false,
                store.latest_revision_at("c").expect("latest"),
                now,
                KEEP.interval_ms,
            ) {
                store
                    .add_revision("c", reason, &text, now, KEEP)
                    .expect("add");
            }
            text = next;
            now += 400;
        }
        let revisions = store.list_revisions("c").expect("list");
        assert_eq!(revisions.len(), 1, "{revisions:?}");
        assert_eq!(revisions[0].reason, RevisionReason::Auto);
        assert_eq!(revisions[0].first_line, "select 1");
        // The next interval brings another.
        assert_eq!(
            before_save(
                &text,
                "x",
                false,
                Some(1_000_000),
                1_000_000 + 5 * 60_000,
                KEEP.interval_ms
            ),
            Some(RevisionReason::BeforeDeletion)
        );
        assert_eq!(
            before_save(
                &text,
                &format!("{text};"),
                false,
                Some(1_000_000),
                1_000_000 + 5 * 60_000,
                KEEP.interval_ms
            ),
            Some(RevisionReason::Auto)
        );
    }

    #[test]
    fn deleting_most_of_the_text_always_keeps_it() {
        assert_eq!(
            before_save(
                "select * from orders where id = 1",
                "",
                false,
                Some(10),
                11,
                KEEP.interval_ms
            ),
            Some(RevisionReason::BeforeDeletion)
        );
        assert_eq!(
            before_save("abc", "abcd", true, Some(10), 11, KEEP.interval_ms),
            Some(RevisionReason::External)
        );
        assert_eq!(before_save("   ", "x", false, None, 0, 1), None);
        assert_eq!(before_save("same", "same", false, None, 0, 1), None);
    }

    #[test]
    fn pruning_keeps_the_newest_per_console_and_drops_old_ones() {
        let store = Store::open_in_memory().expect("open");
        for i in 0..5 {
            store
                .add_revision("a", RevisionReason::BeforeRun, &format!("v{i}"), i, KEEP)
                .expect("add");
        }
        store
            .add_revision("b", RevisionReason::Auto, "other", 5, KEEP)
            .expect("add");
        let kept: Vec<String> = store
            .list_revisions("a")
            .expect("list")
            .into_iter()
            .map(|r| r.first_line)
            .collect();
        assert_eq!(kept, ["v4", "v3", "v2"]);
        // Same text as the latest: not recorded again.
        assert_eq!(
            store
                .add_revision("a", RevisionReason::BeforeRun, "v4", 6, KEEP)
                .expect("dup"),
            None
        );
        // By age: everything older than a day goes.
        let day = 86_400_000;
        let aged = RevisionRetention {
            max_age_days: 1,
            ..KEEP
        };
        store
            .add_revision("b", RevisionReason::Auto, "new", 10 * day, aged)
            .expect("add");
        assert!(store.list_revisions("a").expect("list").is_empty());
        assert_eq!(store.list_revisions("b").expect("list").len(), 1);
    }

    #[test]
    fn revisions_follow_a_rename_and_read_back() {
        let store = Store::open_in_memory().expect("open");
        let id = store
            .add_revision("old", RevisionReason::Auto, "select 42", 1, KEEP)
            .expect("add")
            .expect("id");
        store.rename_revisions("old", "new").expect("rename");
        assert!(store.list_revisions("old").expect("list").is_empty());
        assert_eq!(
            store.revision(id).expect("read"),
            Some(("new".into(), "select 42".into()))
        );
    }

    #[test]
    fn upgrading_from_version_5_adds_an_empty_history() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("app.db");
        {
            let mut raw = rusqlite::Connection::open(&path).expect("raw");
            crate::migrations::migrate_to(&mut raw, 5).expect("v5");
        }
        let store = Store::open(&path).expect("upgrade");
        assert_eq!(store.schema_version().expect("v"), crate::LATEST_VERSION);
        assert!(store.list_revisions("console").expect("list").is_empty());
    }
}
