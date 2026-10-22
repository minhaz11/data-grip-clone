//! What a statement does to the transaction, judged from its leading words (comments and option
//! lists skipped). Used to decide when to open a transaction in Manual mode and when to ask the
//! server for the transaction state; the server's answer is always the authority.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// BEGIN, COMMIT, ROLLBACK, SAVEPOINT, ...: changes the transaction itself.
    Control,
    /// CALL or DO: may commit or roll back internally.
    Procedural,
    /// Cannot run inside a transaction block (VACUUM, CREATE DATABASE, ... CONCURRENTLY).
    NoBlock,
    /// Everything else.
    Other,
}

/// Up to `max` upper-cased leading words, skipping comments and parenthesized option lists.
fn leading_words(sql: &str, max: usize) -> Vec<String> {
    let mut words = Vec::new();
    let mut rest = sql;
    while words.len() < max {
        rest = rest.trim_start();
        if let Some(r) = rest.strip_prefix("--") {
            rest = r.split_once('\n').map_or("", |(_, after)| after);
        } else if let Some(r) = rest.strip_prefix("/*") {
            rest = r.split_once("*/").map_or("", |(_, after)| after);
        } else if let Some(r) = rest.strip_prefix('(') {
            // `VACUUM (VERBOSE) t`, `REINDEX (VERBOSE) TABLE t`: skip the option list.
            rest = r.split_once(')').map_or("", |(_, after)| after);
        } else {
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(rest.len());
            if end == 0 {
                break;
            }
            words.push(rest[..end].to_ascii_uppercase());
            rest = &rest[end..];
        }
    }
    words
}

pub fn kind(sql: &str) -> Kind {
    let w = leading_words(sql, 6);
    let first = w.first().map_or("", String::as_str);
    let second = w.get(1).map_or("", String::as_str);
    let has = |word: &str| w.iter().any(|x| x == word);
    match first {
        "BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "ABORT" | "SAVEPOINT" | "RELEASE" => {
            Kind::Control
        }
        "PREPARE" if second == "TRANSACTION" => Kind::Control,
        "CALL" | "DO" => Kind::Procedural,
        "VACUUM" => Kind::NoBlock,
        "CREATE" | "DROP"
            if matches!(second, "DATABASE" | "TABLESPACE" | "SUBSCRIPTION")
                || (has("INDEX") && has("CONCURRENTLY")) =>
        {
            Kind::NoBlock
        }
        "ALTER" if second == "SYSTEM" => Kind::NoBlock,
        "REINDEX" if has("CONCURRENTLY") || has("DATABASE") || has("SYSTEM") => Kind::NoBlock,
        _ => Kind::Other,
    }
}

/// `SET …` (including `SET TRANSACTION` and `SET SESSION CHARACTERISTICS`), which can switch a
/// transaction or the session default to read-write.
pub fn is_set(sql: &str) -> bool {
    leading_words(sql, 1).first().is_some_and(|w| w == "SET")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transaction_control() {
        for sql in [
            "begin",
            "BEGIN ISOLATION LEVEL SERIALIZABLE",
            "start transaction read write",
            "commit",
            "end",
            "rollback to savepoint a",
            "abort",
            "savepoint a",
            "release a",
            "prepare transaction 'x'",
            "-- comment\n  COMMIT",
            "/* c */ rollback",
        ] {
            assert_eq!(kind(sql), Kind::Control, "{sql}");
        }
        assert_eq!(kind("prepare q as select 1"), Kind::Other);
    }

    #[test]
    fn procedural_and_no_block() {
        assert_eq!(kind("call refresh_all()"), Kind::Procedural);
        assert_eq!(kind("DO $$ begin perform 1; end $$"), Kind::Procedural);
        for sql in [
            "vacuum",
            "VACUUM (VERBOSE, ANALYZE) t",
            "create database x",
            "drop database if exists x",
            "create tablespace t location '/x'",
            "alter system set work_mem = '64MB'",
            "create index concurrently i on t (a)",
            "create unique index concurrently i on t (a)",
            "drop index concurrently i",
            "reindex (verbose) table concurrently t",
            "reindex database app",
        ] {
            assert_eq!(kind(sql), Kind::NoBlock, "{sql}");
        }
    }

    #[test]
    fn ordinary_statements() {
        for sql in [
            "select 1",
            "insert into t values (1)",
            "create index i on t (a)",
            "alter table t add column b int",
            "reindex table t",
            "set search_path to x",
            "",
            "-- only a comment",
        ] {
            assert_eq!(kind(sql), Kind::Other, "{sql}");
        }
    }

    #[test]
    fn detects_set() {
        assert!(is_set("set transaction read write"));
        assert!(is_set("/* x */ SET default_transaction_read_only = off"));
        assert!(!is_set("select set_config('a', 'b', false)"));
        assert!(!is_set("reset all"));
    }
}
