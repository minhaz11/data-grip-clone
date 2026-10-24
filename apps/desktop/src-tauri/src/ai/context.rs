//! The context builder (M6.2, ADR-0005): decides what leaves the machine. Pure functions over
//! catalog models and the user's settings, so every rule here is unit-tested without a server.
//! The ignore list is applied before anything is rendered, and the output is the exact request.

use quarry_ai_core::{CompletionRequest, Message};
use quarry_db_core::{Cell, TableModel};
use quarry_store::{AiContextLevel, AiSettings};
use serde::Deserialize;

/// Upper bound on the schema part of a request; objects past it are left out and listed.
pub const MAX_SCHEMA_CHARS: usize = 60_000;
/// Objects resolved for one request (referenced first, then their foreign-key neighbours).
pub const MAX_OBJECTS: usize = 40;
/// Sample rows per table, tables per request, and characters per cell.
pub const SAMPLE_ROWS: usize = 5;
pub const SAMPLE_TABLES: usize = 3;
pub const SAMPLE_CELL_CHARS: usize = 200;
/// Answers are capped so a runaway response cannot cost much.
pub const MAX_ANSWER_TOKENS: u32 = 16_000;
/// Longest editor text or question accepted.
pub const MAX_INPUT_CHARS: usize = 100_000;

/// What the user asks for. Step 18 adds explain, explain-error and fix.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AiTask {
    /// A free-form question about the SQL in the editor (or a request to write some).
    Ask { question: String },
}

impl AiTask {
    pub fn action(&self) -> &'static str {
        match self {
            Self::Ask { .. } => "ask",
        }
    }

    pub fn text(&self) -> &str {
        match self {
            Self::Ask { question } => question,
        }
    }
}

/// What the request says about the data source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceFacts {
    pub dialect: &'static str,
    /// Short server version, when connected.
    pub server_version: Option<String>,
}

/// A view's columns (views have no table model).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewShape {
    pub schema: String,
    pub name: String,
    pub columns: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowSample {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Cell>>,
}

/// Whether `sql` uses `name` as a whole identifier (case-insensitively), so constraints, index
/// columns and checks that mention an ignored column are dropped with it.
pub fn mentions(sql: &str, name: &str) -> bool {
    let name = name.to_lowercase();
    let lower = sql.to_lowercase();
    let is_ident = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    lower.match_indices(&name).any(|(at, _)| {
        let before = lower[..at].chars().next_back();
        let after = lower[at + name.len()..].chars().next();
        !before.is_some_and(is_ident) && !after.is_some_and(is_ident)
    })
}

/// The table as it may be sent: `None` if the table is ignored; otherwise without ignored
/// columns and without any key, index, check or foreign key that involves one.
pub fn filter_table(mut t: TableModel, settings: &AiSettings) -> Option<TableModel> {
    if settings.ignores_table(&t.schema, &t.name) {
        return None;
    }
    let ignored: Vec<String> = t
        .columns
        .iter()
        .filter(|c| settings.ignores_column(&t.schema, &t.name, &c.name))
        .map(|c| c.name.clone())
        .collect();
    let hit = |cols: &[String]| cols.iter().any(|c| ignored.contains(c));
    t.columns.retain(|c| !ignored.contains(&c.name));
    if t.primary_key.as_ref().is_some_and(|k| hit(&k.columns)) {
        t.primary_key = None;
    }
    t.uniques.retain(|k| !hit(&k.columns));
    t.indexes
        .retain(|i| !ignored.iter().any(|c| mentions(&i.columns, c)));
    t.checks
        .retain(|c| !ignored.iter().any(|col| mentions(&c.expression, col)));
    t.foreign_keys.retain(|fk| {
        !hit(&fk.columns)
            && !settings.ignores_table(&fk.ref_schema, &fk.ref_table)
            && !fk
                .ref_columns
                .iter()
                .any(|c| settings.ignores_column(&fk.ref_schema, &fk.ref_table, c))
    });
    // Column defaults may name an ignored column (generated expressions); drop those defaults.
    for c in &mut t.columns {
        if c.default
            .as_deref()
            .is_some_and(|d| ignored.iter().any(|col| mentions(d, col)))
        {
            c.default = None;
        }
    }
    Some(t)
}

pub fn filter_view(mut v: ViewShape, settings: &AiSettings) -> Option<ViewShape> {
    if settings.ignores_table(&v.schema, &v.name) {
        return None;
    }
    v.columns
        .retain(|(c, _)| !settings.ignores_column(&v.schema, &v.name, c));
    Some(v)
}

fn quote(name: &str) -> String {
    let plain = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if plain {
        name.to_owned()
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

pub fn view_text(v: &ViewShape) -> String {
    let columns: Vec<String> = v
        .columns
        .iter()
        .map(|(n, t)| format!("    {} {t}", quote(n)))
        .collect();
    format!(
        "-- view (definition not included)\n-- {}.{} (\n{}\n-- )",
        quote(&v.schema),
        quote(&v.name),
        columns
            .iter()
            .map(|c| format!("--{c}"))
            .collect::<Vec<_>>()
            .join(",\n")
    )
}

/// Joins object texts up to [`MAX_SCHEMA_CHARS`]; returns the text, the names included and the
/// names left out for size.
pub fn fit_schema(items: Vec<(String, String)>) -> (String, Vec<String>, Vec<String>) {
    let mut text = String::new();
    let mut included = Vec::new();
    let mut omitted = Vec::new();
    for (name, ddl) in items {
        if text.len() + ddl.len() + 2 > MAX_SCHEMA_CHARS {
            omitted.push(name);
            continue;
        }
        if !text.is_empty() {
            text.push_str("\n\n");
        }
        text.push_str(&ddl);
        included.push(name);
    }
    (text, included, omitted)
}

fn cell_text(cell: &Cell) -> String {
    match cell {
        None => "NULL".into(),
        Some(v) => {
            let flat = v.replace(['\t', '\n', '\r'], " ");
            match flat.char_indices().nth(SAMPLE_CELL_CHARS) {
                Some((at, _)) => format!("{}…", &flat[..at]),
                None => flat,
            }
        }
    }
}

fn rows_text(sample: &RowSample) -> String {
    let mut out = format!(
        "Sample rows from {}.{} ({} rows):\n{}",
        quote(&sample.schema),
        quote(&sample.table),
        sample.rows.len(),
        sample.columns.join("\t")
    );
    for row in &sample.rows {
        out.push('\n');
        out.push_str(&row.iter().map(cell_text).collect::<Vec<_>>().join("\t"));
    }
    out
}

const SYSTEM: &str = "You are the SQL assistant inside Quarry, a desktop database client. \
Answer for the database engine named in the message. When you write SQL, put it in one fenced \
```sql block. You cannot run anything: the user reviews SQL and runs it themselves. Use only the \
schema you are given; say so when something you need is missing.";

/// The request for `task`. `schema` and `rows` are already filtered; at level None neither is
/// passed in, so nothing beyond the editor text and the question can be included.
pub fn build_request(
    facts: &SourceFacts,
    task: &AiTask,
    sql: &str,
    level: AiContextLevel,
    schema: &str,
    rows: &[RowSample],
    model: &str,
) -> CompletionRequest {
    let mut parts = Vec::new();
    parts.push(match &facts.server_version {
        Some(v) => format!("Database: {} {v}", facts.dialect),
        None => format!("Database: {}", facts.dialect),
    });
    if level >= AiContextLevel::Schema && !schema.is_empty() {
        parts.push(format!(
            "Schema of the objects involved:\n```sql\n{schema}\n```"
        ));
    }
    if level == AiContextLevel::SchemaAndRows {
        for sample in rows {
            parts.push(rows_text(sample));
        }
    }
    if !sql.trim().is_empty() {
        parts.push(format!(
            "SQL in the editor:\n```sql\n{}\n```",
            sql.trim_end()
        ));
    }
    parts.push(format!("Request: {}", task.text().trim()));
    CompletionRequest {
        model: model.to_owned(),
        system: Some(SYSTEM.into()),
        messages: vec![Message::user(parts.join("\n\n"))],
        max_tokens: MAX_ANSWER_TOKENS,
    }
}

#[cfg(test)]
mod tests {
    use quarry_db_core::{
        CheckModel, ColumnModel, FkAction, ForeignKeyModel, IndexModel, KeyModel,
    };
    use quarry_store::{AiIgnoreKind, AiIgnoreRule};

    use super::*;

    fn col(name: &str, ty: &str) -> ColumnModel {
        ColumnModel {
            name: name.into(),
            original: Some(name.into()),
            type_name: ty.into(),
            not_null: false,
            default: None,
            identity: None,
            comment: None,
        }
    }

    fn users() -> TableModel {
        TableModel {
            schema: "public".into(),
            name: "users".into(),
            comment: None,
            columns: vec![
                col("id", "integer"),
                col("email", "text"),
                col("password_hash", "text"),
                col("org_id", "integer"),
            ],
            primary_key: Some(KeyModel {
                name: None,
                columns: vec!["id".into()],
            }),
            uniques: vec![KeyModel {
                name: None,
                columns: vec!["email".into(), "password_hash".into()],
            }],
            checks: vec![
                CheckModel {
                    name: None,
                    expression: "length(password_hash) > 10".into(),
                },
                CheckModel {
                    name: None,
                    expression: "email <> ''".into(),
                },
            ],
            foreign_keys: vec![ForeignKeyModel {
                name: None,
                columns: vec!["org_id".into()],
                ref_schema: "billing".into(),
                ref_table: "orgs".into(),
                ref_columns: vec!["id".into()],
                on_delete: FkAction::NoAction,
                on_update: FkAction::NoAction,
                deferrable: false,
            }],
            indexes: vec![
                IndexModel {
                    name: Some("users_pw".into()),
                    columns: "lower(password_hash)".into(),
                    unique: false,
                },
                IndexModel {
                    name: Some("users_email".into()),
                    columns: "email".into(),
                    unique: false,
                },
            ],
        }
    }

    fn ignore(rules: &[(AiIgnoreKind, &str)]) -> AiSettings {
        AiSettings {
            ignore: rules
                .iter()
                .map(|(kind, pattern)| AiIgnoreRule {
                    kind: *kind,
                    pattern: (*pattern).into(),
                })
                .collect(),
            ..AiSettings::default()
        }
    }

    #[test]
    fn ignored_columns_and_everything_that_names_them_are_dropped() {
        let s = ignore(&[
            (AiIgnoreKind::Column, "*password*"),
            (AiIgnoreKind::Table, "billing.*"),
        ]);
        let t = filter_table(users(), &s).expect("kept");
        let names: Vec<_> = t.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["id", "email", "org_id"]);
        assert!(t.uniques.is_empty(), "unique over the ignored column");
        assert_eq!(t.checks.len(), 1);
        assert_eq!(t.indexes.len(), 1);
        assert!(t.foreign_keys.is_empty(), "points into an ignored table");
        assert!(t.primary_key.is_some());
        let text = format!("{t:?}").to_lowercase();
        assert!(!text.contains("password"));
        assert!(!text.contains("billing"));
    }

    #[test]
    fn ignored_tables_are_dropped_whole() {
        let s = ignore(&[(AiIgnoreKind::Table, "public.users")]);
        assert!(filter_table(users(), &s).is_none());
        let v = ViewShape {
            schema: "public".into(),
            name: "users".into(),
            columns: vec![("id".into(), "integer".into())],
        };
        assert!(filter_view(v, &s).is_none());
    }

    #[test]
    fn mentions_matches_whole_identifiers_only() {
        assert!(mentions("lower(password_hash)", "password_hash"));
        assert!(mentions("\"Email\" <> ''", "email"));
        assert!(!mentions("email_verified", "email"));
        assert!(!mentions("my_email", "email"));
    }

    #[test]
    fn level_none_sends_only_the_editor_text_and_request() {
        let facts = SourceFacts {
            dialect: "PostgreSQL",
            server_version: Some("16.4".into()),
        };
        let task = AiTask::Ask {
            question: "count users".into(),
        };
        let rows = [RowSample {
            schema: "public".into(),
            table: "users".into(),
            columns: vec!["email".into()],
            rows: vec![vec![Some("a@b.c".into())]],
        }];
        let r = build_request(
            &facts,
            &task,
            "select 1",
            AiContextLevel::None,
            "CREATE TABLE secret_schema (x int)",
            &rows,
            "claude-sonnet-5-5",
        );
        let text = &r.messages[0].content;
        assert!(text.contains("Database: PostgreSQL 16.4"));
        assert!(text.contains("select 1"));
        assert!(text.contains("Request: count users"));
        assert!(!text.contains("secret_schema"));
        assert!(!text.contains("a@b.c"));
        // Schema level: schema yes, rows no.
        let r = build_request(
            &facts,
            &task,
            "",
            AiContextLevel::Schema,
            "CREATE TABLE t (x int)",
            &rows,
            "m",
        );
        assert!(r.messages[0].content.contains("CREATE TABLE t"));
        assert!(!r.messages[0].content.contains("a@b.c"));
        assert!(!r.messages[0].content.contains("SQL in the editor"));
        // Rows level: rows too, flattened and capped.
        let long = RowSample {
            rows: vec![vec![Some(format!("a\tb\n{}", "x".repeat(500))), None]],
            columns: vec!["note".into(), "gone".into()],
            ..rows[0].clone()
        };
        let r = build_request(
            &facts,
            &task,
            "",
            AiContextLevel::SchemaAndRows,
            "",
            &[long],
            "m",
        );
        let text = &r.messages[0].content;
        assert!(text.contains("Sample rows from public.users (1 rows):\nnote\tgone\na b "));
        assert!(text.contains("…\tNULL"));
    }

    #[test]
    fn schema_is_capped_and_says_what_was_left_out() {
        let big = "x".repeat(MAX_SCHEMA_CHARS / 2);
        let (text, included, omitted) = fit_schema(vec![
            ("a".into(), big.clone()),
            ("b".into(), big.clone()),
            ("c".into(), "small".into()),
        ]);
        assert_eq!(included, ["a", "c"]);
        assert_eq!(omitted, ["b"]);
        assert!(text.len() <= MAX_SCHEMA_CHARS);
    }

    #[test]
    fn views_render_as_comments() {
        let text = view_text(&ViewShape {
            schema: "public".into(),
            name: "Active Users".into(),
            columns: vec![("id".into(), "integer".into())],
        });
        assert!(text.contains("public.\"Active Users\""));
        assert!(text.contains("--    id integer"));
    }
}
