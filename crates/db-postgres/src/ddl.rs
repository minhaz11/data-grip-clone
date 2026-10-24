//! DDL generated from the catalog (M4.4).
//!
//! Runs on its own connection with a fixed `search_path` (empty when names are qualified), so the
//! server's own functions (`regclass`, `pg_get_*def`, `quote_ident`, `quote_literal`) qualify and
//! quote every name consistently. The script is ordered to apply cleanly: schemas, sequences,
//! routines, tables (without foreign keys), views in dependency order, sequence ownership,
//! indexes, foreign keys, triggers.

use std::collections::{BTreeMap, HashSet};

use quarry_db_core::{DdlObject, DdlOptions};
use tokio_postgres::Client;

#[derive(Debug)]
pub enum DdlError {
    Db(tokio_postgres::Error),
    /// An object that does not exist (any more).
    Missing(String),
}

impl From<tokio_postgres::Error> for DdlError {
    fn from(e: tokio_postgres::Error) -> Self {
        Self::Db(e)
    }
}

type Result<T> = std::result::Result<T, DdlError>;

/// Statements, each emitted with a trailing semicolon.
#[derive(Default)]
struct Script(Vec<String>);

impl Script {
    fn push(&mut self, statement: impl Into<String>) {
        let s: String = statement.into();
        let s = s.trim_end().trim_end_matches(';').trim_end().to_owned();
        if !s.is_empty() {
            self.0.push(format!("{s};"));
        }
    }

    fn render(&self) -> String {
        let mut out = self.0.join("\n\n");
        out.push('\n');
        out
    }
}

// ---- resolving what to generate ----

const SCHEMA_EXISTS: &str = "SELECT oid FROM pg_namespace WHERE nspname = $1";

const RELATION_BY_NAME: &str = "
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm')";

const SCHEMA_RELATIONS: &str = "
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm')
    ORDER BY c.relname";

const SEQUENCE_BY_NAME: &str = "
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'S'";

/// Sequences of a schema, except identity sequences (created by their column).
const SCHEMA_SEQUENCES: &str = "
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind = 'S'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                        AND d.deptype = 'i')
    ORDER BY c.relname";

/// Sequences owned by columns of `$1` (serial), which the table's defaults need first.
const OWNED_SEQUENCES: &str = "
    SELECT d.objid FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
    WHERE d.classid = 'pg_class'::regclass AND d.refobjid = $1 AND d.deptype = 'a'";

const ROUTINE_BY_NAME: &str = "
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND p.proname = $2 AND pg_get_function_identity_arguments(p.oid) = $3";

const SCHEMA_ROUTINES: &str = "
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                        AND d.deptype = 'e')
    ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)";

const INDEX_BY_NAME: &str = "
    SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('i', 'I')";

const TRIGGER_BY_NAME: &str = "
    SELECT t.oid FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3 AND NOT t.tgisinternal";

// ---- generating ----

const SCHEMA_DDL: &str = "
    SELECT quote_ident(n.nspname), quote_literal(obj_description(n.oid, 'pg_namespace')),
           quote_ident(pg_get_userbyid(n.nspowner))
    FROM pg_namespace n WHERE n.oid = $1";

const RELATION: &str = "
    SELECT c.relkind::text, c.oid::regclass::text, c.relpersistence::text,
           CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
           c.relispartition,
           CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END,
           (SELECT i.inhparent::regclass::text FROM pg_inherits i WHERE i.inhrelid = c.oid
            LIMIT 1),
           quote_literal(obj_description(c.oid, 'pg_class')),
           quote_ident(pg_get_userbyid(c.relowner)),
           c.reloptions, c.relispopulated, c.relname
    FROM pg_class c WHERE c.oid = $1";

const COLUMNS: &str = "
    SELECT quote_ident(a.attname), format_type(a.atttypid, a.atttypmod),
           CASE WHEN a.attcollation <> t.typcollation AND a.attcollation <> 0
                THEN a.attcollation::regcollation::text END,
           a.attnotnull, a.attidentity::text, a.attgenerated::text,
           pg_get_expr(d.adbin, d.adrelid),
           quote_literal(col_description(a.attrelid, a.attnum))
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum";

/// Primary key, unique, check and exclusion constraints declared on the table itself.
const TABLE_CONSTRAINTS: &str = "
    SELECT quote_ident(k.conname), pg_get_constraintdef(k.oid)
    FROM pg_constraint k
    WHERE k.conrelid = $1 AND k.contype IN ('p', 'u', 'c', 'x') AND k.conislocal
    ORDER BY k.contype = 'p' DESC, k.conname";

const FOREIGN_KEYS: &str = "
    SELECT quote_ident(k.conname), pg_get_constraintdef(k.oid)
    FROM pg_constraint k
    WHERE k.conrelid = $1 AND k.contype = 'f' AND k.conparentid = 0
    ORDER BY k.conname";

/// Indexes that do not back a constraint and were not created for a partition by its parent.
const INDEXES: &str = "
    SELECT x.indexrelid
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    WHERE x.indrelid = $1
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                      WHERE k.conrelid = x.indrelid AND k.conindid = x.indexrelid
                        AND k.contype IN ('p', 'u', 'x'))
      AND NOT EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = x.indexrelid)
    ORDER BY i.relname";

const INDEX: &str = "
    SELECT pg_get_indexdef(c.oid), c.oid::regclass::text,
           quote_literal(obj_description(c.oid, 'pg_class')), c.relkind = 'I'
    FROM pg_class c WHERE c.oid = $1";

const TRIGGERS: &str = "
    SELECT t.oid FROM pg_trigger t
    WHERE t.tgrelid = $1 AND NOT t.tgisinternal AND t.tgparentid = 0
    ORDER BY t.tgname";

const TRIGGER: &str = "
    SELECT pg_get_triggerdef(t.oid), t.tgenabled::text, t.tgrelid::regclass::text,
           quote_ident(t.tgname), quote_literal(obj_description(t.oid, 'pg_trigger'))
    FROM pg_trigger t WHERE t.oid = $1";

const SEQUENCE: &str = "
    SELECT c.oid::regclass::text, format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement,
           s.seqmin, s.seqmax, s.seqcache, s.seqcycle,
           quote_literal(obj_description(c.oid, 'pg_class')),
           quote_ident(pg_get_userbyid(c.relowner)),
           (SELECT d.refobjid::regclass::text || '.' || quote_ident(a.attname)
            FROM pg_depend d
            JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
            WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'a'),
           (SELECT d.refobjid FROM pg_depend d
            WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'a')
    FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid
    WHERE c.oid = $1";

const ROUTINE: &str = "
    SELECT p.prokind::text, p.oid::regprocedure::text,
           CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid) END,
           quote_literal(obj_description(p.oid, 'pg_proc')),
           quote_ident(pg_get_userbyid(p.proowner)),
           EXISTS (SELECT 1 FROM pg_type t
                   WHERE t.oid = ANY (p.proargtypes::oid[] || p.prorettype)
                     AND t.typrelid <> 0)
    FROM pg_proc p WHERE p.oid = $1";

/// Views and materialized views among `$1` and the ones among `$1` they read from.
const VIEW_DEPENDENCIES: &str = "
    SELECT DISTINCT r.ev_class, d.refobjid
    FROM pg_rewrite r
    JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
    WHERE r.ev_class = ANY ($1) AND d.refobjid = ANY ($1) AND d.refobjid <> r.ev_class";

/// Privileges granted to others than the owner, one row per grantee.
const GRANTS: &str = "
    SELECT string_agg(g.privilege_type, ', ' ORDER BY g.privilege_type),
           CASE WHEN g.grantee = 0 THEN 'PUBLIC'
                ELSE quote_ident(pg_get_userbyid(g.grantee)) END,
           g.is_grantable
    FROM aclexplode($1::aclitem[]) g
    WHERE g.grantee <> $2::oid
    GROUP BY g.grantee, g.is_grantable
    ORDER BY 2";

async fn one_oid(client: &Client, sql: &str, args: &[&str], what: String) -> Result<u32> {
    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = args
        .iter()
        .map(|a| a as &(dyn tokio_postgres::types::ToSql + Sync))
        .collect();
    match client.query_opt(sql, &params).await? {
        Some(row) => Ok(row.get(0)),
        None => Err(DdlError::Missing(what)),
    }
}

async fn oids(client: &Client, sql: &str, schema: &str) -> Result<Vec<u32>> {
    Ok(client
        .query(sql, &[&schema])
        .await?
        .iter()
        .map(|r| r.get(0))
        .collect())
}

fn push_unique(list: &mut Vec<u32>, oid: u32) {
    if !list.contains(&oid) {
        list.push(oid);
    }
}

#[derive(Default)]
struct Plan {
    schemas: Vec<u32>,
    relations: Vec<u32>,
    sequences: Vec<u32>,
    routines: Vec<u32>,
    indexes: Vec<u32>,
    triggers: Vec<u32>,
}

async fn plan(client: &Client, objects: &[DdlObject]) -> Result<Plan> {
    let mut p = Plan::default();
    for object in objects {
        match object {
            DdlObject::Schema { schema } => {
                let oid =
                    one_oid(client, SCHEMA_EXISTS, &[schema], format!("schema {schema}")).await?;
                push_unique(&mut p.schemas, oid);
                for o in oids(client, SCHEMA_RELATIONS, schema).await? {
                    push_unique(&mut p.relations, o);
                }
                for o in oids(client, SCHEMA_SEQUENCES, schema).await? {
                    push_unique(&mut p.sequences, o);
                }
                for o in oids(client, SCHEMA_ROUTINES, schema).await? {
                    push_unique(&mut p.routines, o);
                }
            }
            DdlObject::Relation { schema, name } => {
                let oid = one_oid(
                    client,
                    RELATION_BY_NAME,
                    &[schema, name],
                    format!("{schema}.{name}"),
                )
                .await?;
                push_unique(&mut p.relations, oid);
            }
            DdlObject::Sequence { schema, name } => {
                let oid = one_oid(
                    client,
                    SEQUENCE_BY_NAME,
                    &[schema, name],
                    format!("sequence {schema}.{name}"),
                )
                .await?;
                push_unique(&mut p.sequences, oid);
            }
            DdlObject::Routine { schema, name, args } => {
                let oid = one_oid(
                    client,
                    ROUTINE_BY_NAME,
                    &[schema, name, args],
                    format!("routine {schema}.{name}({args})"),
                )
                .await?;
                push_unique(&mut p.routines, oid);
            }
            DdlObject::Index { schema, name } => {
                let oid = one_oid(
                    client,
                    INDEX_BY_NAME,
                    &[schema, name],
                    format!("index {schema}.{name}"),
                )
                .await?;
                push_unique(&mut p.indexes, oid);
            }
            DdlObject::Trigger {
                schema,
                table,
                name,
            } => {
                let oid = one_oid(
                    client,
                    TRIGGER_BY_NAME,
                    &[schema, table, name],
                    format!("trigger {name} on {schema}.{table}"),
                )
                .await?;
                push_unique(&mut p.triggers, oid);
            }
        }
    }
    // Serial columns need their sequences first.
    for &rel in &p.relations.clone() {
        for row in client.query(OWNED_SEQUENCES, &[&rel]).await? {
            push_unique(&mut p.sequences, row.get(0));
        }
    }
    Ok(p)
}

/// The schema every object lives in, if they all share one.
fn home_schema(objects: &[DdlObject]) -> Option<&str> {
    let mut schemas = objects.iter().map(|o| match o {
        DdlObject::Relation { schema, .. }
        | DdlObject::Sequence { schema, .. }
        | DdlObject::Routine { schema, .. }
        | DdlObject::Index { schema, .. }
        | DdlObject::Trigger { schema, .. }
        | DdlObject::Schema { schema } => schema.as_str(),
    });
    let first = schemas.next()?;
    schemas.all(|s| s == first).then_some(first)
}

struct Gen<'a> {
    client: &'a Client,
    options: &'a DdlOptions,
    script: Script,
}

impl Gen<'_> {
    async fn grants(&mut self, acl_sql: &str, oid: u32, on: &str) -> Result<()> {
        if !self.options.grants {
            return Ok(());
        }
        // `acl_sql` returns (acl, owner) for the object.
        let Some(row) = self.client.query_opt(acl_sql, &[&oid]).await? else {
            return Ok(());
        };
        let acl: Option<String> = row.get(0);
        let owner: u32 = row.get(1);
        let Some(acl) = acl else { return Ok(()) };
        for g in self.client.query(GRANTS, &[&acl, &owner]).await? {
            let privileges: String = g.get(0);
            let grantee: String = g.get(1);
            let grantable: bool = g.get(2);
            self.script.push(format!(
                "GRANT {privileges} ON {on} TO {grantee}{}",
                if grantable { " WITH GRANT OPTION" } else { "" }
            ));
        }
        Ok(())
    }

    fn owner(&mut self, keyword: &str, name: &str, owner: &str) {
        if self.options.owner {
            self.script
                .push(format!("ALTER {keyword} {name} OWNER TO {owner}"));
        }
    }

    fn comment(&mut self, on: &str, literal: Option<String>) {
        if let Some(literal) = literal {
            self.script.push(format!("COMMENT ON {on} IS {literal}"));
        }
    }

    async fn schema(&mut self, oid: u32) -> Result<()> {
        let row = self.client.query_one(SCHEMA_DDL, &[&oid]).await?;
        let name: String = row.get(0);
        self.script.push(format!("CREATE SCHEMA {name}"));
        self.comment(&format!("SCHEMA {name}"), row.get(1));
        self.owner("SCHEMA", &name, &row.get::<_, String>(2));
        self.grants(
            "SELECT nspacl::text, nspowner FROM pg_namespace WHERE oid = $1",
            oid,
            &format!("SCHEMA {name}"),
        )
        .await
    }

    async fn sequence(&mut self, oid: u32) -> Result<Option<(String, u32)>> {
        let r = self.client.query_one(SEQUENCE, &[&oid]).await?;
        let name: String = r.get(0);
        let ty: String = r.get(1);
        let (start, increment, min, max, cache): (i64, i64, i64, i64, i64) =
            (r.get(2), r.get(3), r.get(4), r.get(5), r.get(6));
        let cycle: bool = r.get(7);
        self.script.push(format!(
            "CREATE SEQUENCE {name} AS {ty}\n    START WITH {start}\n    INCREMENT BY {increment}\n    MINVALUE {min}\n    MAXVALUE {max}\n    CACHE {cache}{}",
            if cycle { "\n    CYCLE" } else { "" }
        ));
        self.comment(&format!("SEQUENCE {name}"), r.get(8));
        self.owner("SEQUENCE", &name, &r.get::<_, String>(9));
        self.grants(
            "SELECT relacl::text, relowner FROM pg_class WHERE oid = $1",
            oid,
            &format!("SEQUENCE {name}"),
        )
        .await?;
        // `ALTER SEQUENCE … OWNED BY` comes after the owning table exists.
        let owned_by: Option<String> = r.get(10);
        let owner_table: Option<u32> = r.get(11);
        Ok(owned_by
            .zip(owner_table)
            .map(|(col, table)| (format!("ALTER SEQUENCE {name} OWNED BY {col}"), table)))
    }

    async fn routine(&mut self, oid: u32) -> Result<()> {
        let r = self.client.query_one(ROUTINE, &[&oid]).await?;
        let kind: String = r.get(0);
        let signature: String = r.get(1);
        let Some(def) = r.get::<_, Option<String>>(2) else {
            self.script.0.push(format!(
                "-- aggregate {signature}: DDL for aggregates is not generated yet"
            ));
            return Ok(());
        };
        self.script.push(def);
        let keyword = if kind == "p" { "PROCEDURE" } else { "FUNCTION" };
        self.comment(&format!("{keyword} {signature}"), r.get(3));
        self.owner(keyword, &signature, &r.get::<_, String>(4));
        self.grants(
            "SELECT proacl::text, proowner FROM pg_proc WHERE oid = $1",
            oid,
            &format!("{keyword} {signature}"),
        )
        .await
    }

    async fn relation(&mut self, oid: u32) -> Result<()> {
        let r = self.client.query_one(RELATION, &[&oid]).await?;
        let relkind: String = r.get(0);
        let name: String = r.get(1);
        let keyword = match relkind.as_str() {
            "v" => "VIEW",
            "m" => "MATERIALIZED VIEW",
            _ => "TABLE",
        };
        match relkind.as_str() {
            "v" | "m" => {
                let def: String = self
                    .client
                    .query_one("SELECT pg_get_viewdef($1::oid, true)", &[&oid])
                    .await?
                    .get(0);
                let def = def.trim_end().trim_end_matches(';').to_owned();
                let options: Option<Vec<String>> = r.get(9);
                let with = options
                    .filter(|o| !o.is_empty())
                    .map(|o| format!(" WITH ({})", o.join(", ")))
                    .unwrap_or_default();
                if relkind == "v" {
                    self.script
                        .push(format!("CREATE VIEW {name}{with} AS\n{def}"));
                } else {
                    let populated: bool = r.get(10);
                    self.script.push(format!(
                        "CREATE MATERIALIZED VIEW {name} AS\n{def}\nWITH {}",
                        if populated { "DATA" } else { "NO DATA" }
                    ));
                }
            }
            _ => self.table(oid, &r, &name).await?,
        }
        self.comment(&format!("{keyword} {name}"), r.get(7));
        if !r.get::<_, bool>(4) {
            // Partitions inherit column comments from nowhere; only list their own.
            for c in self.client.query(COLUMNS, &[&oid]).await? {
                let column: String = c.get(0);
                self.comment(&format!("COLUMN {name}.{column}"), c.get(7));
            }
        }
        self.owner(keyword, &name, &r.get::<_, String>(8));
        self.grants(
            "SELECT relacl::text, relowner FROM pg_class WHERE oid = $1",
            oid,
            &format!("TABLE {name}"),
        )
        .await
    }

    async fn table(&mut self, oid: u32, r: &tokio_postgres::Row, name: &str) -> Result<()> {
        let unlogged = r.get::<_, String>(2) == "u";
        let create = if unlogged {
            "CREATE UNLOGGED TABLE"
        } else {
            "CREATE TABLE"
        };
        if r.get::<_, bool>(4) {
            let parent: String = r.get::<_, Option<String>>(6).unwrap_or_default();
            let bound: String = r.get::<_, Option<String>>(5).unwrap_or_default();
            self.script.push(format!(
                "{create} {name} PARTITION OF {parent}\n    {bound}"
            ));
            return Ok(());
        }
        let mut lines = Vec::new();
        for c in self.client.query(COLUMNS, &[&oid]).await? {
            let column: String = c.get(0);
            let ty: String = c.get(1);
            let collation: Option<String> = c.get(2);
            let not_null: bool = c.get(3);
            let identity: String = c.get(4);
            let generated: String = c.get(5);
            let expr: Option<String> = c.get(6);
            let mut line = format!("    {column} {ty}");
            if let Some(collation) = collation {
                line.push_str(&format!(" COLLATE {collation}"));
            }
            if generated == "s" {
                if let Some(expr) = &expr {
                    line.push_str(&format!(" GENERATED ALWAYS AS ({expr}) STORED"));
                }
            } else if let Some(expr) = &expr {
                line.push_str(&format!(" DEFAULT {expr}"));
            }
            match identity.as_str() {
                "a" => line.push_str(" GENERATED ALWAYS AS IDENTITY"),
                "d" => line.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
                _ => {}
            }
            if not_null {
                line.push_str(" NOT NULL");
            }
            lines.push(line);
        }
        for k in self.client.query(TABLE_CONSTRAINTS, &[&oid]).await? {
            let cname: String = k.get(0);
            let def: String = k.get(1);
            lines.push(format!("    CONSTRAINT {cname} {def}"));
        }
        let partition_by = r
            .get::<_, Option<String>>(3)
            .map(|p| format!("\nPARTITION BY {p}"))
            .unwrap_or_default();
        self.script.push(format!(
            "{create} {name} (\n{}\n){partition_by}",
            lines.join(",\n")
        ));
        Ok(())
    }

    async fn index(&mut self, oid: u32) -> Result<()> {
        let r = self.client.query_one(INDEX, &[&oid]).await?;
        let mut def: String = r.get(0);
        if r.get::<_, bool>(3) {
            // The server writes partitioned indexes as `ON ONLY parent` (pg_dump then creates each
            // partition's index and attaches it). Partition indexes are not listed here, so let
            // the parent's index create and attach them.
            def = def.replacen(" ON ONLY ", " ON ", 1);
        }
        self.script.push(def);
        let name: String = r.get(1);
        self.comment(&format!("INDEX {name}"), r.get(2));
        Ok(())
    }

    async fn trigger(&mut self, oid: u32) -> Result<()> {
        let r = self.client.query_one(TRIGGER, &[&oid]).await?;
        self.script.push(r.get::<_, String>(0));
        let enabled: String = r.get(1);
        let table: String = r.get(2);
        let name: String = r.get(3);
        if enabled == "D" {
            self.script
                .push(format!("ALTER TABLE {table} DISABLE TRIGGER {name}"));
        }
        self.comment(&format!("TRIGGER {name} ON {table}"), r.get(4));
        Ok(())
    }
}

/// Views and materialized views ordered so each comes after the ones it reads.
async fn view_order(client: &Client, views: &[u32]) -> Result<Vec<u32>> {
    let mut deps: BTreeMap<u32, HashSet<u32>> =
        views.iter().map(|&v| (v, HashSet::new())).collect();
    for row in client.query(VIEW_DEPENDENCIES, &[&views]).await? {
        let (view, uses): (u32, u32) = (row.get(0), row.get(1));
        deps.entry(view).or_default().insert(uses);
    }
    let mut ordered = Vec::new();
    let mut done = HashSet::new();
    // Repeatedly take, in the given (name) order, every view whose dependencies are done.
    while ordered.len() < views.len() {
        let ready: Vec<u32> = views
            .iter()
            .copied()
            .filter(|v| !done.contains(v) && deps[v].iter().all(|d| done.contains(d)))
            .collect();
        if ready.is_empty() {
            // A cycle cannot exist between views; keep the rest in name order.
            ordered.extend(views.iter().copied().filter(|v| !done.contains(v)));
            break;
        }
        for v in ready {
            done.insert(v);
            ordered.push(v);
        }
    }
    Ok(ordered)
}

/// The DDL script for `objects`. The caller's connection must be one this function may change
/// `search_path` on (a dedicated, short-lived connection).
pub async fn generate(
    client: &Client,
    objects: &[DdlObject],
    options: &DdlOptions,
) -> Result<String> {
    match (options.qualify, home_schema(objects)) {
        (false, Some(schema)) => {
            client
                .execute(
                    "SELECT set_config('search_path', quote_ident($1), false)",
                    &[&schema],
                )
                .await?;
        }
        _ => client.batch_execute("SET search_path = ''").await?,
    }
    let plan = plan(client, objects).await?;

    let mut g = Gen {
        client,
        options,
        script: Script::default(),
    };
    if !plan.routines.is_empty() && plan.relations.len() + plan.routines.len() > 1 {
        // Like pg_dump: SQL function bodies may refer to tables created further down.
        g.script.push("SET check_function_bodies = false");
    }
    for &oid in &plan.schemas {
        g.schema(oid).await?;
    }
    let mut ownerships = Vec::new();
    for &oid in &plan.sequences {
        if let Some(ownership) = g.sequence(oid).await? {
            ownerships.push(ownership);
        }
    }

    // Routines whose signatures use a table's row type wait for the tables.
    let mut late_routines = Vec::new();
    for &oid in &plan.routines {
        let uses_rowtype: bool = client.query_one(ROUTINE, &[&oid]).await?.get(5);
        if uses_rowtype {
            late_routines.push(oid);
        } else {
            g.routine(oid).await?;
        }
    }

    let mut tables = Vec::new();
    let mut partitions = Vec::new();
    let mut views = Vec::new();
    for &oid in &plan.relations {
        let row = client
            .query_one(
                "SELECT relkind::text, relispartition FROM pg_class WHERE oid = $1",
                &[&oid],
            )
            .await?;
        let relkind: String = row.get(0);
        match (relkind.as_str(), row.get::<_, bool>(1)) {
            ("v" | "m", _) => views.push(oid),
            (_, true) => partitions.push(oid),
            _ => tables.push(oid),
        }
    }
    for &oid in tables.iter().chain(&partitions) {
        g.relation(oid).await?;
    }
    for oid in late_routines {
        g.routine(oid).await?;
    }
    for oid in view_order(client, &views).await? {
        g.relation(oid).await?;
    }
    let included: HashSet<u32> = plan.relations.iter().copied().collect();
    for (statement, table) in ownerships {
        if included.contains(&table) {
            g.script.push(statement);
        }
    }

    let with_indexes: Vec<u32> = tables
        .iter()
        .chain(&partitions)
        .chain(&views)
        .copied()
        .collect();
    let mut indexes = Vec::new();
    for &rel in &with_indexes {
        for row in client.query(INDEXES, &[&rel]).await? {
            push_unique(&mut indexes, row.get(0));
        }
    }
    for &oid in &plan.indexes {
        push_unique(&mut indexes, oid);
    }
    for oid in indexes {
        g.index(oid).await?;
    }

    for &rel in tables.iter().chain(&partitions) {
        let name: String = client
            .query_one("SELECT $1::oid::regclass::text", &[&rel])
            .await?
            .get(0);
        for k in client.query(FOREIGN_KEYS, &[&rel]).await? {
            let cname: String = k.get(0);
            let def: String = k.get(1);
            g.script.push(format!(
                "ALTER TABLE {name}\n    ADD CONSTRAINT {cname} {def}"
            ));
        }
    }

    let mut triggers = Vec::new();
    for &rel in &with_indexes {
        for row in client.query(TRIGGERS, &[&rel]).await? {
            push_unique(&mut triggers, row.get(0));
        }
    }
    for &oid in &plan.triggers {
        push_unique(&mut triggers, oid);
    }
    for oid in triggers {
        g.trigger(oid).await?;
    }

    Ok(g.script.render())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_ends_every_statement_once() {
        let mut s = Script::default();
        s.push("CREATE TABLE t (a int)");
        s.push("SELECT 1;  \n");
        s.push("   ");
        assert_eq!(s.render(), "CREATE TABLE t (a int);\n\nSELECT 1;\n");
    }

    #[test]
    fn home_schema_needs_one_shared_schema() {
        let rel = |s: &str| DdlObject::Relation {
            schema: s.into(),
            name: "t".into(),
        };
        assert_eq!(home_schema(&[rel("a"), rel("a")]), Some("a"));
        assert_eq!(home_schema(&[rel("a"), rel("b")]), None);
        assert_eq!(home_schema(&[]), None);
    }
}
