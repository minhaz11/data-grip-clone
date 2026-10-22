//! Statements for schema changes made through forms (M4.5), and the table model they start from.
//!
//! Names are always quoted here (only when needed, like `quote_ident`). Type names must match a
//! strict grammar. Defaults, check expressions and index columns are SQL the user writes; the
//! preview shows them exactly as they will run.

use std::collections::HashMap;

use quarry_db_core::{
    CheckModel, ColumnModel, DropObject, FkAction, ForeignKeyModel, Identity, IndexModel, KeyModel,
    ObjectType, RenameObject, SchemaChange, TableModel, TableName,
};
use tokio_postgres::Client;

/// Words PostgreSQL reserves (plus those only allowed as function or type names): an identifier
/// spelled like one of these must be quoted.
const RESERVED: &[&str] = &[
    "all",
    "analyse",
    "analyze",
    "and",
    "any",
    "array",
    "as",
    "asc",
    "asymmetric",
    "authorization",
    "binary",
    "both",
    "case",
    "cast",
    "check",
    "collate",
    "collation",
    "column",
    "concurrently",
    "constraint",
    "create",
    "cross",
    "current_catalog",
    "current_date",
    "current_role",
    "current_schema",
    "current_time",
    "current_timestamp",
    "current_user",
    "default",
    "deferrable",
    "desc",
    "distinct",
    "do",
    "else",
    "end",
    "except",
    "false",
    "fetch",
    "for",
    "foreign",
    "freeze",
    "from",
    "full",
    "grant",
    "group",
    "having",
    "ilike",
    "in",
    "initially",
    "inner",
    "intersect",
    "into",
    "is",
    "isnull",
    "join",
    "lateral",
    "leading",
    "left",
    "like",
    "limit",
    "localtime",
    "localtimestamp",
    "natural",
    "not",
    "notnull",
    "null",
    "offset",
    "on",
    "only",
    "or",
    "order",
    "outer",
    "overlaps",
    "placing",
    "primary",
    "references",
    "returning",
    "right",
    "select",
    "session_user",
    "similar",
    "some",
    "symmetric",
    "system_user",
    "table",
    "tablesample",
    "then",
    "to",
    "trailing",
    "true",
    "union",
    "unique",
    "user",
    "using",
    "variadic",
    "verbose",
    "when",
    "where",
    "window",
    "with",
];

/// An identifier as SQL: bare when that reads back the same, otherwise double-quoted.
pub fn ident(name: &str) -> String {
    let plain = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c == '_')
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        && !RESERVED.contains(&name);
    if plain {
        name.to_owned()
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

pub fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", ident(schema), ident(name))
}

/// A string literal (standard-conforming strings: only `'` needs doubling).
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn is_word(w: &str) -> bool {
    w.chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A type name such as `integer`, `numeric(10, 2)`, `timestamp(3) with time zone`, `text[]` or
/// `myschema.mood`, normalized; `Err` for anything else (quotes, semicolons, expressions).
pub fn type_sql(raw: &str) -> Result<String, String> {
    let bad = || Err(format!("\"{}\" is not a type name.", raw.trim()));
    let mut rest = raw.trim();
    if rest.is_empty() {
        return Err("A type is required.".into());
    }
    let mut arrays = String::new();
    while let Some(stripped) = rest.strip_suffix(']') {
        let Some(open) = stripped.rfind('[') else {
            return bad();
        };
        let size = &stripped[open + 1..];
        if !size.chars().all(|c| c.is_ascii_digit()) {
            return bad();
        }
        arrays.insert_str(0, &format!("[{size}]"));
        rest = stripped[..open].trim_end();
    }
    let (before, modifier, after) = match rest.find('(') {
        Some(open) => {
            let Some(close) = rest.rfind(')') else {
                return bad();
            };
            if close < open {
                return bad();
            }
            let inner = &rest[open + 1..close];
            let parts: Vec<&str> = inner.split(',').map(str::trim).collect();
            if parts.is_empty()
                || parts.len() > 2
                || parts
                    .iter()
                    .any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()))
            {
                return bad();
            }
            (
                &rest[..open],
                format!("({})", parts.join(", ")),
                &rest[close + 1..],
            )
        }
        None => (rest, String::new(), ""),
    };
    let words = |s: &str| -> Option<Vec<String>> {
        s.split_whitespace()
            .map(|w| {
                let ok = w.split('.').count() <= 2 && w.split('.').all(is_word);
                ok.then(|| w.to_owned())
            })
            .collect()
    };
    let (Some(head), Some(tail)) = (words(before), words(after)) else {
        return bad();
    };
    if head.is_empty() || head.iter().skip(1).any(|w| w.contains('.')) {
        return bad();
    }
    let mut out = head.join(" ");
    out.push_str(&modifier);
    if !tail.is_empty() {
        out.push(' ');
        out.push_str(&tail.join(" "));
    }
    out.push_str(&arrays);
    Ok(out)
}

fn need(text: &str, what: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        Err(format!("{what} is required."))
    } else if text.len() > 63 {
        Err(format!("{what} is longer than 63 bytes."))
    } else {
        Ok(())
    }
}

fn column_list(columns: &[String]) -> String {
    columns
        .iter()
        .map(|c| ident(c))
        .collect::<Vec<_>>()
        .join(", ")
}

fn named(name: &Option<String>) -> String {
    name.as_deref()
        .filter(|n| !n.trim().is_empty())
        .map(|n| format!("CONSTRAINT {} ", ident(n)))
        .unwrap_or_default()
}

fn column_sql(c: &ColumnModel) -> Result<String, String> {
    need(&c.name, "A column name")?;
    let mut sql = format!("{} {}", ident(&c.name), type_sql(&c.type_name)?);
    if let Some(identity) = c.identity {
        if c.default.as_deref().is_some_and(|d| !d.trim().is_empty()) {
            return Err(format!(
                "Column {} cannot have both a default and identity.",
                c.name
            ));
        }
        sql.push_str(match identity {
            Identity::Always => " GENERATED ALWAYS AS IDENTITY",
            Identity::ByDefault => " GENERATED BY DEFAULT AS IDENTITY",
        });
    } else if let Some(d) = c.default.as_deref().filter(|d| !d.trim().is_empty()) {
        sql.push_str(&format!(" DEFAULT {}", d.trim()));
    }
    if c.not_null {
        sql.push_str(" NOT NULL");
    }
    Ok(sql)
}

fn key_sql(kind: &str, k: &KeyModel) -> Result<String, String> {
    if k.columns.is_empty() {
        return Err(format!(
            "A {} needs at least one column.",
            kind.to_lowercase()
        ));
    }
    Ok(format!(
        "{}{kind} ({})",
        named(&k.name),
        column_list(&k.columns)
    ))
}

fn check_sql(c: &CheckModel) -> Result<String, String> {
    if c.expression.trim().is_empty() {
        return Err("A check needs an expression.".into());
    }
    Ok(format!("{}CHECK ({})", named(&c.name), c.expression.trim()))
}

fn fk_sql(f: &ForeignKeyModel) -> Result<String, String> {
    if f.columns.is_empty() || f.columns.len() != f.ref_columns.len() {
        return Err("A foreign key needs as many referenced columns as columns.".into());
    }
    need(&f.ref_table, "The referenced table")?;
    let mut sql = format!(
        "{}FOREIGN KEY ({}) REFERENCES {} ({})",
        named(&f.name),
        column_list(&f.columns),
        qualified(&f.ref_schema, &f.ref_table),
        column_list(&f.ref_columns)
    );
    if f.on_delete != FkAction::NoAction {
        sql.push_str(&format!(" ON DELETE {}", f.on_delete.sql()));
    }
    if f.on_update != FkAction::NoAction {
        sql.push_str(&format!(" ON UPDATE {}", f.on_update.sql()));
    }
    if f.deferrable {
        sql.push_str(" DEFERRABLE");
    }
    Ok(sql)
}

fn index_sql(table: &str, i: &IndexModel) -> Result<String, String> {
    let columns = i.columns.trim();
    if columns.is_empty() {
        return Err("An index needs columns.".into());
    }
    // `btree (lower(email))` names a method; plain `a, b DESC` does not.
    let method = columns
        .split_once(' ')
        .is_some_and(|(word, rest)| is_word(word) && rest.trim_start().starts_with('('));
    let target = if method {
        format!("USING {columns}")
    } else {
        format!("({columns})")
    };
    let name = i
        .name
        .as_deref()
        .filter(|n| !n.trim().is_empty())
        .map(|n| format!("{} ", ident(n)))
        .unwrap_or_default();
    Ok(format!(
        "CREATE {}INDEX {name}ON {table} {target}",
        if i.unique { "UNIQUE " } else { "" }
    ))
}

fn validate(m: &TableModel) -> Result<(), String> {
    need(&m.schema, "A schema")?;
    need(&m.name, "A table name")?;
    if m.columns.is_empty() {
        return Err("A table needs at least one column.".into());
    }
    let mut seen = std::collections::HashSet::new();
    for c in &m.columns {
        if !seen.insert(c.name.as_str()) {
            return Err(format!("Column {} appears twice.", c.name));
        }
    }
    let known = |cols: &[String]| -> Result<(), String> {
        match cols.iter().find(|c| !seen.contains(c.as_str())) {
            Some(c) => Err(format!("{c} is not a column of this table.")),
            None => Ok(()),
        }
    };
    if let Some(pk) = &m.primary_key {
        known(&pk.columns)?;
    }
    for u in &m.uniques {
        known(&u.columns)?;
    }
    for f in &m.foreign_keys {
        known(&f.columns)?;
    }
    Ok(())
}

fn comments(table: &str, m: &TableModel, out: &mut Vec<String>) {
    if let Some(c) = m.comment.as_deref().filter(|c| !c.is_empty()) {
        out.push(format!("COMMENT ON TABLE {table} IS {}", literal(c)));
    }
    for col in &m.columns {
        if let Some(c) = col.comment.as_deref().filter(|c| !c.is_empty()) {
            out.push(format!(
                "COMMENT ON COLUMN {table}.{} IS {}",
                ident(&col.name),
                literal(c)
            ));
        }
    }
}

pub fn create_table(m: &TableModel) -> Result<Vec<String>, String> {
    validate(m)?;
    let table = qualified(&m.schema, &m.name);
    let mut lines = Vec::new();
    for c in &m.columns {
        lines.push(column_sql(c)?);
    }
    if let Some(pk) = &m.primary_key {
        lines.push(key_sql("PRIMARY KEY", pk)?);
    }
    for u in &m.uniques {
        lines.push(key_sql("UNIQUE", u)?);
    }
    for c in &m.checks {
        lines.push(check_sql(c)?);
    }
    for f in &m.foreign_keys {
        lines.push(fk_sql(f)?);
    }
    let mut out = vec![format!(
        "CREATE TABLE {table} (\n    {}\n)",
        lines.join(",\n    ")
    )];
    for i in &m.indexes {
        out.push(index_sql(&table, i)?);
    }
    comments(&table, m, &mut out);
    Ok(out)
}

pub fn alter_table(original: &TableModel, edited: &TableModel) -> Result<Vec<String>, String> {
    validate(edited)?;
    if edited.schema != original.schema {
        return Err("Moving a table to another schema is not supported here.".into());
    }
    let mut out = Vec::new();
    let mut table = qualified(&original.schema, &original.name);
    if edited.name != original.name {
        out.push(format!(
            "ALTER TABLE {table} RENAME TO {}",
            ident(&edited.name)
        ));
        table = qualified(&edited.schema, &edited.name);
    }
    let alter = |clause: String| format!("ALTER TABLE {table} {clause}");

    // Renamed columns, so constraints that only follow a rename count as unchanged.
    let renames: HashMap<&str, &str> = edited
        .columns
        .iter()
        .filter_map(|c| c.original.as_deref().map(|o| (o, c.name.as_str())))
        .collect();
    let follow = |cols: &[String]| -> Vec<String> {
        cols.iter()
            .map(|c| {
                renames
                    .get(c.as_str())
                    .map_or(c.clone(), |n| (*n).to_owned())
            })
            .collect()
    };
    let same_key = |a: &KeyModel, b: &KeyModel| a.name == b.name && follow(&a.columns) == b.columns;
    let same_fk = |a: &ForeignKeyModel, b: &ForeignKeyModel| {
        ForeignKeyModel {
            columns: follow(&a.columns),
            ..a.clone()
        } == *b
    };
    let by_name = |name: &Option<String>| name.clone().filter(|n| !n.is_empty());

    // 1. Drop what is removed or changed (before columns go, which would drop them silently).
    let mut add_constraints = Vec::new();
    let pk_changed = match (&original.primary_key, &edited.primary_key) {
        (Some(a), Some(b)) => !same_key(a, b),
        (None, None) => false,
        _ => true,
    };
    if pk_changed {
        if let Some(name) = original.primary_key.as_ref().and_then(|k| by_name(&k.name)) {
            out.push(alter(format!("DROP CONSTRAINT {}", ident(&name))));
        }
        if let Some(pk) = &edited.primary_key {
            add_constraints.push(key_sql("PRIMARY KEY", pk)?);
        }
    }
    let diff_named = |old: Vec<(Option<String>, String)>,
                      new: Vec<(Option<String>, String)>|
     -> (Vec<String>, Vec<String>) {
        // Returns (names to drop, definitions to add); kept when name and definition match.
        let drops = old
            .iter()
            .filter(|(n, d)| !new.iter().any(|(m, e)| m == n && e == d))
            .filter_map(|(n, _)| n.clone())
            .collect();
        let adds = new
            .iter()
            .filter(|(n, d)| n.is_none() || !old.iter().any(|(m, e)| m == n && e == d))
            .map(|(_, d)| d.clone())
            .collect();
        (drops, adds)
    };
    let unique_def = |k: &KeyModel, followed: bool| -> Result<(Option<String>, String), String> {
        let k = KeyModel {
            name: by_name(&k.name),
            columns: if followed {
                follow(&k.columns)
            } else {
                k.columns.clone()
            },
        };
        Ok((k.name.clone(), key_sql("UNIQUE", &k)?))
    };
    let (drop_u, add_u) = diff_named(
        original
            .uniques
            .iter()
            .map(|k| unique_def(k, true))
            .collect::<Result<_, _>>()?,
        edited
            .uniques
            .iter()
            .map(|k| unique_def(k, false))
            .collect::<Result<_, _>>()?,
    );
    let check_def = |c: &CheckModel| -> Result<(Option<String>, String), String> {
        Ok((by_name(&c.name), check_sql(c)?))
    };
    let (drop_c, add_c) = diff_named(
        original
            .checks
            .iter()
            .map(check_def)
            .collect::<Result<_, _>>()?,
        edited
            .checks
            .iter()
            .map(check_def)
            .collect::<Result<_, _>>()?,
    );
    let mut drop_f = Vec::new();
    let mut add_f = Vec::new();
    for f in &original.foreign_keys {
        if !edited.foreign_keys.iter().any(|g| same_fk(f, g))
            && let Some(name) = by_name(&f.name)
        {
            drop_f.push(name);
        }
    }
    for g in &edited.foreign_keys {
        if !original.foreign_keys.iter().any(|f| same_fk(f, g)) {
            add_f.push(fk_sql(g)?);
        }
    }
    for name in drop_f.iter().chain(&drop_u).chain(&drop_c) {
        out.push(alter(format!("DROP CONSTRAINT {}", ident(name))));
    }
    let index_def = |i: &IndexModel| (by_name(&i.name), (i.columns.trim().to_owned(), i.unique));
    let old_idx: Vec<_> = original.indexes.iter().map(index_def).collect();
    let new_idx: Vec<_> = edited.indexes.iter().map(index_def).collect();
    for (name, def) in &old_idx {
        if !new_idx.iter().any(|(n, d)| n == name && d == def)
            && let Some(name) = name
        {
            out.push(format!("DROP INDEX {}", qualified(&original.schema, name)));
        }
    }

    // 2. Columns: drop, rename, alter, add.
    for c in &original.columns {
        if !edited
            .columns
            .iter()
            .any(|e| e.original.as_deref() == Some(c.name.as_str()))
        {
            out.push(alter(format!("DROP COLUMN {}", ident(&c.name))));
        }
    }
    let originals: HashMap<&str, &ColumnModel> = original
        .columns
        .iter()
        .map(|c| (c.name.as_str(), c))
        .collect();
    for e in &edited.columns {
        let Some(o) = e.original.as_deref().and_then(|o| originals.get(o)) else {
            continue;
        };
        if e.name != o.name {
            out.push(alter(format!(
                "RENAME COLUMN {} TO {}",
                ident(&o.name),
                ident(&e.name)
            )));
        }
        let col = ident(&e.name);
        let new_type = type_sql(&e.type_name)?;
        if type_sql(&o.type_name).ok().as_deref() != Some(new_type.as_str()) {
            out.push(alter(format!("ALTER COLUMN {col} TYPE {new_type}")));
        }
        let default = |c: &ColumnModel| c.default.clone().filter(|d| !d.trim().is_empty());
        if default(e) != default(o) {
            out.push(alter(match default(e) {
                Some(d) => format!("ALTER COLUMN {col} SET DEFAULT {}", d.trim()),
                None => format!("ALTER COLUMN {col} DROP DEFAULT"),
            }));
        }
        if e.identity != o.identity {
            out.push(alter(match (o.identity, e.identity) {
                (None, Some(Identity::Always)) => {
                    format!("ALTER COLUMN {col} ADD GENERATED ALWAYS AS IDENTITY")
                }
                (None, Some(Identity::ByDefault)) => {
                    format!("ALTER COLUMN {col} ADD GENERATED BY DEFAULT AS IDENTITY")
                }
                (Some(_), None) => format!("ALTER COLUMN {col} DROP IDENTITY"),
                (Some(_), Some(Identity::Always)) => {
                    format!("ALTER COLUMN {col} SET GENERATED ALWAYS")
                }
                (Some(_), Some(Identity::ByDefault)) => {
                    format!("ALTER COLUMN {col} SET GENERATED BY DEFAULT")
                }
                (None, None) => unreachable!("identity differs"),
            }));
        }
        if e.not_null != o.not_null {
            out.push(alter(format!(
                "ALTER COLUMN {col} {} NOT NULL",
                if e.not_null { "SET" } else { "DROP" }
            )));
        }
    }
    for e in edited.columns.iter().filter(|e| e.original.is_none()) {
        out.push(alter(format!("ADD COLUMN {}", column_sql(e)?)));
    }

    // 3. Add constraints and indexes, then comments.
    for def in add_constraints
        .iter()
        .chain(&add_u)
        .chain(&add_c)
        .chain(&add_f)
    {
        out.push(alter(format!("ADD {def}")));
    }
    for i in &edited.indexes {
        let def = index_def(i);
        if def.0.is_none() || !old_idx.contains(&def) {
            out.push(index_sql(&table, i)?);
        }
    }
    let text = |c: &Option<String>| c.clone().filter(|c| !c.is_empty());
    if text(&edited.comment) != text(&original.comment) {
        out.push(format!(
            "COMMENT ON TABLE {table} IS {}",
            text(&edited.comment).map_or("NULL".into(), |c| literal(&c))
        ));
    }
    for e in &edited.columns {
        let before = e
            .original
            .as_deref()
            .and_then(|o| originals.get(o))
            .and_then(|o| text(&o.comment));
        if text(&e.comment) != before {
            out.push(format!(
                "COMMENT ON COLUMN {table}.{} IS {}",
                ident(&e.name),
                text(&e.comment).map_or("NULL".into(), |c| literal(&c))
            ));
        }
    }
    Ok(out)
}

fn relation_keyword(t: ObjectType) -> &'static str {
    match t {
        ObjectType::Table => "TABLE",
        ObjectType::View => "VIEW",
        ObjectType::MaterializedView => "MATERIALIZED VIEW",
    }
}

fn routine_args(args: &str) -> Result<&str, String> {
    // Identity arguments as the catalog writes them; never statement text.
    if args.contains(';') || args.contains("--") || args.contains("/*") {
        return Err("Unexpected routine arguments.".into());
    }
    Ok(args)
}

pub fn build(change: &SchemaChange) -> Result<Vec<String>, String> {
    match change {
        SchemaChange::CreateTable { table } => create_table(table),
        SchemaChange::AlterTable { original, table } => alter_table(original, table),
        SchemaChange::Drop {
            objects,
            if_exists,
            cascade,
        } => {
            if objects.is_empty() {
                return Err("Nothing to drop.".into());
            }
            let exists = if *if_exists { "IF EXISTS " } else { "" };
            let cascade = if *cascade { " CASCADE" } else { "" };
            objects
                .iter()
                .map(|o| {
                    Ok(match o {
                        DropObject::Relation {
                            schema,
                            name,
                            object_type,
                        } => format!(
                            "DROP {} {exists}{}{cascade}",
                            relation_keyword(*object_type),
                            qualified(schema, name)
                        ),
                        DropObject::Sequence { schema, name } => {
                            format!("DROP SEQUENCE {exists}{}{cascade}", qualified(schema, name))
                        }
                        DropObject::Routine {
                            schema,
                            name,
                            args,
                            procedure,
                        } => format!(
                            "DROP {} {exists}{}({}){cascade}",
                            if *procedure { "PROCEDURE" } else { "FUNCTION" },
                            qualified(schema, name),
                            routine_args(args)?
                        ),
                        DropObject::Index { schema, name } => {
                            format!("DROP INDEX {exists}{}{cascade}", qualified(schema, name))
                        }
                        DropObject::Trigger {
                            schema,
                            table,
                            name,
                        } => format!(
                            "DROP TRIGGER {exists}{} ON {}{cascade}",
                            ident(name),
                            qualified(schema, table)
                        ),
                        DropObject::Schema { schema } => {
                            format!("DROP SCHEMA {exists}{}{cascade}", ident(schema))
                        }
                    })
                })
                .collect()
        }
        SchemaChange::Truncate {
            tables,
            restart_identity,
            cascade,
        } => {
            if tables.is_empty() {
                return Err("Nothing to truncate.".into());
            }
            let names: Vec<String> = tables
                .iter()
                .map(|TableName { schema, name }| qualified(schema, name))
                .collect();
            Ok(vec![format!(
                "TRUNCATE TABLE {}{}{}",
                names.join(", "),
                if *restart_identity {
                    " RESTART IDENTITY"
                } else {
                    ""
                },
                if *cascade { " CASCADE" } else { "" }
            )])
        }
        SchemaChange::Rename { object, new_name } => {
            need(new_name, "A new name")?;
            let to = ident(new_name);
            Ok(vec![match object {
                RenameObject::Relation {
                    schema,
                    name,
                    object_type,
                } => format!(
                    "ALTER {} {} RENAME TO {to}",
                    relation_keyword(*object_type),
                    qualified(schema, name)
                ),
                RenameObject::Column {
                    schema,
                    table,
                    name,
                } => format!(
                    "ALTER TABLE {} RENAME COLUMN {} TO {to}",
                    qualified(schema, table),
                    ident(name)
                ),
                RenameObject::Schema { schema } => {
                    format!("ALTER SCHEMA {} RENAME TO {to}", ident(schema))
                }
            }])
        }
    }
}

// ---- loading the model (Modify Table) ----

const MODEL_TABLE: &str = "
    SELECT c.oid, obj_description(c.oid, 'pg_class')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')";

const MODEL_COLUMNS: &str = "
    SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), a.attnotnull,
           CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END,
           a.attidentity::text, col_description(a.attrelid, a.attnum)
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum";

const MODEL_KEYS: &str = "
    SELECT k.conname::text, k.contype::text,
           ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
                 ORDER BY u.ord),
           pg_get_constraintdef(k.oid)
    FROM pg_constraint k
    WHERE k.conrelid = $1 AND k.contype IN ('p', 'u', 'c') AND k.conislocal
    ORDER BY k.conname";

const MODEL_FKS: &str = "
    SELECT k.conname::text,
           ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
                 ORDER BY u.ord),
           n.nspname::text, c.relname::text,
           ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum
                 ORDER BY u.ord),
           k.confdeltype::text, k.confupdtype::text, k.condeferrable
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.confrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE k.conrelid = $1 AND k.contype = 'f'
    ORDER BY k.conname";

const MODEL_INDEXES: &str = "
    SELECT i.relname::text, pg_get_indexdef(x.indexrelid), x.indisunique
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    WHERE x.indrelid = $1
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                      WHERE k.conrelid = x.indrelid AND k.conindid = x.indexrelid)
    ORDER BY i.relname";

fn fk_action(code: &str) -> FkAction {
    match code {
        "r" => FkAction::Restrict,
        "c" => FkAction::Cascade,
        "n" => FkAction::SetNull,
        "d" => FkAction::SetDefault,
        _ => FkAction::NoAction,
    }
}

/// The table as an editable model; `None` if it does not exist.
pub async fn load_model(
    client: &Client,
    schema: &str,
    name: &str,
) -> Result<Option<TableModel>, tokio_postgres::Error> {
    let Some(base) = client.query_opt(MODEL_TABLE, &[&schema, &name]).await? else {
        return Ok(None);
    };
    let oid: u32 = base.get(0);
    let columns = client
        .query(MODEL_COLUMNS, &[&oid])
        .await?
        .iter()
        .map(|r| {
            let name: String = r.get(0);
            ColumnModel {
                original: Some(name.clone()),
                name,
                type_name: r.get(1),
                not_null: r.get(2),
                default: r.get(3),
                identity: match r.get::<_, String>(4).as_str() {
                    "a" => Some(Identity::Always),
                    "d" => Some(Identity::ByDefault),
                    _ => None,
                },
                comment: r.get(5),
            }
        })
        .collect();
    let mut primary_key = None;
    let mut uniques = Vec::new();
    let mut checks = Vec::new();
    for r in client.query(MODEL_KEYS, &[&oid]).await? {
        let name: String = r.get(0);
        let contype: String = r.get(1);
        let columns: Vec<String> = r.get(2);
        let def: String = r.get(3);
        match contype.as_str() {
            "p" => {
                primary_key = Some(KeyModel {
                    name: Some(name),
                    columns,
                })
            }
            "u" => uniques.push(KeyModel {
                name: Some(name),
                columns,
            }),
            _ => {
                // "CHECK ((qty > 0))" -> "(qty > 0)"
                let expression = def
                    .strip_prefix("CHECK (")
                    .and_then(|d| d.strip_suffix(')'))
                    .unwrap_or(&def)
                    .to_owned();
                checks.push(CheckModel {
                    name: Some(name),
                    expression,
                });
            }
        }
    }
    let foreign_keys = client
        .query(MODEL_FKS, &[&oid])
        .await?
        .iter()
        .map(|r| ForeignKeyModel {
            name: Some(r.get(0)),
            columns: r.get(1),
            ref_schema: r.get(2),
            ref_table: r.get(3),
            ref_columns: r.get(4),
            on_delete: fk_action(&r.get::<_, String>(5)),
            on_update: fk_action(&r.get::<_, String>(6)),
            deferrable: r.get(7),
        })
        .collect();
    let indexes = client
        .query(MODEL_INDEXES, &[&oid])
        .await?
        .iter()
        .map(|r| {
            let def: String = r.get(1);
            IndexModel {
                name: Some(r.get(0)),
                // "CREATE INDEX x ON s.t USING btree (a)" -> "btree (a)"
                columns: def
                    .split_once(" USING ")
                    .map_or(def.clone(), |(_, rest)| rest.to_owned()),
                unique: r.get(2),
            }
        })
        .collect();
    Ok(Some(TableModel {
        schema: schema.to_owned(),
        name: name.to_owned(),
        comment: base.get(1),
        columns,
        primary_key,
        uniques,
        checks,
        foreign_keys,
        indexes,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, ty: &str) -> ColumnModel {
        ColumnModel {
            name: name.into(),
            original: None,
            type_name: ty.into(),
            not_null: false,
            default: None,
            identity: None,
            comment: None,
        }
    }

    fn existing(c: ColumnModel) -> ColumnModel {
        ColumnModel {
            original: Some(c.name.clone()),
            ..c
        }
    }

    fn table(columns: Vec<ColumnModel>) -> TableModel {
        TableModel {
            schema: "shop".into(),
            name: "orders".into(),
            comment: None,
            columns,
            primary_key: None,
            uniques: vec![],
            checks: vec![],
            foreign_keys: vec![],
            indexes: vec![],
        }
    }

    #[test]
    fn identifiers_are_quoted_only_when_needed() {
        assert_eq!(ident("orders"), "orders");
        assert_eq!(ident("Orders"), "\"Orders\"");
        assert_eq!(ident("order"), "\"order\"");
        assert_eq!(ident("line items"), "\"line items\"");
        assert_eq!(ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(ident("1st"), "\"1st\"");
        assert_eq!(qualified("Shop", "user"), "\"Shop\".\"user\"");
    }

    #[test]
    fn type_names_follow_a_strict_grammar() {
        for (raw, out) in [
            ("integer", "integer"),
            ("  character   varying(80) ", "character varying(80)"),
            ("numeric(10,2)", "numeric(10, 2)"),
            ("timestamp(3) with time zone", "timestamp(3) with time zone"),
            ("text[]", "text[]"),
            ("int[][3]", "int[][3]"),
            ("myschema.mood", "myschema.mood"),
        ] {
            assert_eq!(type_sql(raw).as_deref(), Ok(out), "{raw}");
        }
        for bad in [
            "",
            "int; drop table x",
            "\"int\"",
            "int)",
            "numeric(a)",
            "numeric(1,2,3)",
            "text[x]",
            "a.b.c",
            "int -- c",
            "varchar(80) default 'x'",
        ] {
            assert!(type_sql(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn creates_a_table_with_every_part() {
        let mut m = table(vec![
            ColumnModel {
                identity: Some(Identity::Always),
                not_null: true,
                ..col("id", "bigint")
            },
            ColumnModel {
                default: Some("'pending'".into()),
                not_null: true,
                comment: Some("Who's next".into()),
                ..col("Status", "text")
            },
            col("customer_id", "bigint"),
        ]);
        m.comment = Some("Orders".into());
        m.primary_key = Some(KeyModel {
            name: None,
            columns: vec!["id".into()],
        });
        m.uniques = vec![KeyModel {
            name: Some("orders_status_key".into()),
            columns: vec!["Status".into()],
        }];
        m.checks = vec![CheckModel {
            name: None,
            expression: "length(\"Status\") > 0".into(),
        }];
        m.foreign_keys = vec![ForeignKeyModel {
            name: None,
            columns: vec!["customer_id".into()],
            ref_schema: "shop".into(),
            ref_table: "customers".into(),
            ref_columns: vec!["id".into()],
            on_delete: FkAction::Cascade,
            on_update: FkAction::NoAction,
            deferrable: true,
        }];
        m.indexes = vec![IndexModel {
            name: Some("orders_recent".into()),
            columns: "customer_id, id DESC".into(),
            unique: false,
        }];
        assert_eq!(
            create_table(&m).expect("create"),
            vec![
                "CREATE TABLE shop.orders (\n    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,\n    \"Status\" text DEFAULT 'pending' NOT NULL,\n    customer_id bigint,\n    PRIMARY KEY (id),\n    CONSTRAINT orders_status_key UNIQUE (\"Status\"),\n    CHECK (length(\"Status\") > 0),\n    FOREIGN KEY (customer_id) REFERENCES shop.customers (id) ON DELETE CASCADE DEFERRABLE\n)".to_owned(),
                "CREATE INDEX orders_recent ON shop.orders (customer_id, id DESC)".to_owned(),
                "COMMENT ON TABLE shop.orders IS 'Orders'".to_owned(),
                "COMMENT ON COLUMN shop.orders.\"Status\" IS 'Who''s next'".to_owned(),
            ]
        );
    }

    #[test]
    fn create_rejects_bad_models() {
        assert!(create_table(&table(vec![])).is_err());
        assert!(create_table(&table(vec![col("a", "int; drop")])).is_err());
        assert!(create_table(&table(vec![col("a", "int"), col("a", "int")])).is_err());
        let mut m = table(vec![col("a", "int")]);
        m.primary_key = Some(KeyModel {
            name: None,
            columns: vec!["b".into()],
        });
        assert_eq!(
            create_table(&m).expect_err("unknown key column"),
            "b is not a column of this table."
        );
        let both = ColumnModel {
            identity: Some(Identity::ByDefault),
            default: Some("1".into()),
            ..col("a", "int")
        };
        assert!(create_table(&table(vec![both])).is_err());
    }

    #[test]
    fn unchanged_model_alters_nothing() {
        let mut m = table(vec![
            existing(col("id", "bigint")),
            existing(col("note", "text")),
        ]);
        m.primary_key = Some(KeyModel {
            name: Some("orders_pkey".into()),
            columns: vec!["id".into()],
        });
        m.indexes = vec![IndexModel {
            name: Some("orders_note".into()),
            columns: "btree (note)".into(),
            unique: false,
        }];
        assert_eq!(
            alter_table(&m, &m.clone()).expect("alter"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn alters_columns_constraints_and_comments_in_a_safe_order() {
        let mut original = table(vec![
            existing(col("id", "bigint")),
            existing(col("qty", "integer")),
            existing(col("old_note", "text")),
            existing(col("gone", "text")),
        ]);
        original.primary_key = Some(KeyModel {
            name: Some("orders_pkey".into()),
            columns: vec!["id".into()],
        });
        original.uniques = vec![KeyModel {
            name: Some("orders_note_key".into()),
            columns: vec!["old_note".into()],
        }];
        original.checks = vec![CheckModel {
            name: Some("qty_positive".into()),
            expression: "(qty > 0)".into(),
        }];
        let mut edited = original.clone();
        edited.name = "purchases".into();
        edited.columns = vec![
            existing(col("id", "bigint")),
            ColumnModel {
                type_name: "bigint".into(),
                not_null: true,
                default: Some("1".into()),
                ..existing(col("qty", "integer"))
            },
            ColumnModel {
                name: "note".into(),
                ..existing(col("old_note", "text"))
            },
            ColumnModel {
                comment: Some("New".into()),
                ..col("added", "date")
            },
        ];
        // The unique key follows the rename: unchanged. The check changes: drop and add.
        edited.uniques = vec![KeyModel {
            name: Some("orders_note_key".into()),
            columns: vec!["note".into()],
        }];
        edited.checks = vec![CheckModel {
            name: Some("qty_positive".into()),
            expression: "qty >= 1".into(),
        }];
        assert_eq!(
            alter_table(&original, &edited).expect("alter"),
            vec![
                "ALTER TABLE shop.orders RENAME TO purchases",
                "ALTER TABLE shop.purchases DROP CONSTRAINT qty_positive",
                "ALTER TABLE shop.purchases DROP COLUMN gone",
                "ALTER TABLE shop.purchases ALTER COLUMN qty TYPE bigint",
                "ALTER TABLE shop.purchases ALTER COLUMN qty SET DEFAULT 1",
                "ALTER TABLE shop.purchases ALTER COLUMN qty SET NOT NULL",
                "ALTER TABLE shop.purchases RENAME COLUMN old_note TO note",
                "ALTER TABLE shop.purchases ADD COLUMN added date",
                "ALTER TABLE shop.purchases ADD CONSTRAINT qty_positive CHECK (qty >= 1)",
                "COMMENT ON COLUMN shop.purchases.added IS 'New'",
            ]
        );
    }

    #[test]
    fn drops_truncates_and_renames() {
        let drop = build(&SchemaChange::Drop {
            objects: vec![
                DropObject::Relation {
                    schema: "shop".into(),
                    name: "Order".into(),
                    object_type: ObjectType::MaterializedView,
                },
                DropObject::Routine {
                    schema: "shop".into(),
                    name: "price".into(),
                    args: "qty integer".into(),
                    procedure: false,
                },
                DropObject::Trigger {
                    schema: "shop".into(),
                    table: "orders".into(),
                    name: "touch".into(),
                },
            ],
            if_exists: true,
            cascade: true,
        })
        .expect("drop");
        assert_eq!(
            drop,
            [
                "DROP MATERIALIZED VIEW IF EXISTS shop.\"Order\" CASCADE",
                "DROP FUNCTION IF EXISTS shop.price(qty integer) CASCADE",
                "DROP TRIGGER IF EXISTS touch ON shop.orders CASCADE",
            ]
        );
        assert!(
            build(&SchemaChange::Drop {
                objects: vec![DropObject::Routine {
                    schema: "s".into(),
                    name: "f".into(),
                    args: "int); drop table x; --".into(),
                    procedure: false,
                }],
                if_exists: false,
                cascade: false,
            })
            .is_err()
        );
        assert_eq!(
            build(&SchemaChange::Truncate {
                tables: vec![
                    TableName {
                        schema: "shop".into(),
                        name: "orders".into()
                    },
                    TableName {
                        schema: "shop".into(),
                        name: "order items".into()
                    },
                ],
                restart_identity: true,
                cascade: false,
            })
            .expect("truncate"),
            ["TRUNCATE TABLE shop.orders, shop.\"order items\" RESTART IDENTITY"]
        );
        assert_eq!(
            build(&SchemaChange::Rename {
                object: RenameObject::Column {
                    schema: "shop".into(),
                    table: "orders".into(),
                    name: "qty".into(),
                },
                new_name: "Quantity".into(),
            })
            .expect("rename"),
            ["ALTER TABLE shop.orders RENAME COLUMN qty TO \"Quantity\""]
        );
        assert!(
            build(&SchemaChange::Rename {
                object: RenameObject::Schema {
                    schema: "shop".into()
                },
                new_name: "  ".into(),
            })
            .is_err()
        );
    }
}
