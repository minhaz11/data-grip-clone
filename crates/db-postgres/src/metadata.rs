//! PostgreSQL catalog queries for the lazy explorer tree. Every query is fixed text with bind
//! parameters; identifiers from the user never reach SQL text.

use quarry_db_core::{
    ColumnDetail, ConstraintDetail, ForeignKeyDetail, IndexDetail, MetaKind, MetaNode,
    MetadataRequest as Req, ObjectDetails, ObjectRef, ObjectType, TriggerDetail,
};
use tokio_postgres::{Client, Row};

const SCHEMAS: &str = "
    SELECT n.nspname, obj_description(n.oid, 'pg_namespace')
    FROM pg_namespace n
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND has_schema_privilege(n.oid, 'USAGE')
    ORDER BY n.nspname";

const SCHEMA_COUNTS: &str = "
    SELECT count(*) FILTER (WHERE c.relkind IN ('r', 'p')),
           count(*) FILTER (WHERE c.relkind = 'v'),
           count(*) FILTER (WHERE c.relkind = 'm'),
           count(*) FILTER (WHERE c.relkind = 'S'),
           (SELECT count(*) FROM pg_proc p
            WHERE p.pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
              AND NOT EXISTS (SELECT 1 FROM pg_depend d
                              WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                                AND d.deptype = 'e'))
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND NOT c.relispartition";

const OBJECTS: &str = "
    SELECT c.relname, c.relkind::text, obj_description(c.oid, 'pg_class')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind::text = ANY($2) AND NOT c.relispartition
    ORDER BY c.relname";

const OBJECT_COUNTS: &str = "
    SELECT (SELECT count(*) FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped),
           (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid),
           (SELECT count(*) FROM pg_constraint k
            WHERE k.conrelid = c.oid AND k.contype IN ('p', 'u', 'x')),
           (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f'),
           (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'c'),
           (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2";

const CONSTRAINTS: &str = "
    SELECT k.conname, k.contype::text, pg_get_constraintdef(k.oid, true)
    FROM pg_constraint k
    JOIN pg_class c ON c.oid = k.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND k.contype::text = ANY($3)
    ORDER BY k.contype = 'p' DESC, k.conname";

const TRIGGERS: &str = "
    SELECT t.tgname, pg_get_triggerdef(t.oid, true), t.tgenabled <> 'D', quote_ident(t.tgname)
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND NOT t.tgisinternal
    ORDER BY t.tgname";

/// User routines only: functions created by extensions are left out.
const ROUTINES: &str = "
    SELECT p.proname, pg_get_function_identity_arguments(p.oid),
           CASE WHEN p.prokind = 'p' THEN NULL ELSE pg_get_function_result(p.oid) END,
           p.prokind::text, obj_description(p.oid, 'pg_proc')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1
      AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                        AND d.deptype = 'e')
    ORDER BY p.proname, 2";

const SEQUENCES: &str = "
    SELECT c.relname, format_type(s.seqtypid, NULL), s.seqincrement,
           (SELECT d.refobjid::regclass::text || '.' || a.attname
            FROM pg_depend d
            JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
            WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
              AND d.deptype IN ('a', 'i')
            LIMIT 1)
    FROM pg_sequence s
    JOIN pg_class c ON c.oid = s.seqrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1
    ORDER BY c.relname";

// ---- object details (table viewer) ----

const DETAIL_BASE: &str = "
    SELECT c.oid, c.relkind::text, obj_description(c.oid, 'pg_class'),
           CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END,
           CASE WHEN c.relkind IN ('r', 'p', 'm') THEN pg_total_relation_size(c.oid) END
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')";

const DETAIL_COLUMNS: &str = "
    SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
           CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END,
           EXISTS (SELECT 1 FROM pg_index i
                   WHERE i.indrelid = a.attrelid AND i.indisprimary
                     AND a.attnum = ANY (i.indkey)),
           CASE a.attidentity WHEN 'a' THEN 'always' WHEN 'd' THEN 'by default' END,
           CASE WHEN a.attgenerated <> '' THEN pg_get_expr(d.adbin, d.adrelid) END,
           col_description(a.attrelid, a.attnum)
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum";

const DETAIL_INDEXES: &str = "
    SELECT i.relname, pg_get_indexdef(x.indexrelid), x.indisunique, x.indisprimary
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    WHERE x.indrelid = $1
    ORDER BY x.indisprimary DESC, i.relname";

const DETAIL_CONSTRAINTS: &str = "
    SELECT k.conname, k.contype::text, pg_get_constraintdef(k.oid, true)
    FROM pg_constraint k
    WHERE k.conrelid = $1 AND k.contype IN ('p', 'u', 'c', 'x')
    ORDER BY k.contype = 'p' DESC, k.conname";

/// Foreign keys with both ends, filtered by `$1 = ANY (ARRAY[conrelid])` or confrelid below.
const FOREIGN_KEYS: &str = "
    SELECT k.conname, n1.nspname::text, c1.relname::text,
           ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.attnum
                 ORDER BY u.ord),
           n2.nspname::text, c2.relname::text,
           ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.attnum
                 ORDER BY u.ord),
           k.confupdtype::text, k.confdeltype::text, k.condeferrable
    FROM pg_constraint k
    JOIN pg_class c1 ON c1.oid = k.conrelid JOIN pg_namespace n1 ON n1.oid = c1.relnamespace
    JOIN pg_class c2 ON c2.oid = k.confrelid JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
    WHERE k.contype = 'f'";

const DETAIL_TRIGGERS: &str = "
    SELECT t.tgname, pg_get_triggerdef(t.oid, true), t.tgenabled <> 'D', quote_ident(t.tgname)
    FROM pg_trigger t
    WHERE t.tgrelid = $1 AND NOT t.tgisinternal
    ORDER BY t.tgname";

const COLUMNS: &str = "
    SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
           pg_get_expr(d.adbin, d.adrelid),
           EXISTS (SELECT 1 FROM pg_index i
                   WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey))
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = $1 AND c.relname = $2
    ORDER BY a.attnum";

const RELATIONS: &str = "
    SELECT n.nspname, c.relname, c.relkind::text
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
      AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND has_schema_privilege(n.oid, 'USAGE')
    ORDER BY n.nspname, c.relname";

/// Callable functions for completion. Built-ins that only serve the system (type input/output,
/// operator implementations, `internal` arguments or results, trigger functions) are left out.
pub const FUNCTIONS: &str = "
    SELECT n.nspname, p.proname, pg_get_function_arguments(p.oid),
           pg_get_function_result(p.oid), p.prokind::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prokind IN ('f', 'a', 'w', 'p')
      AND n.nspname <> 'information_schema' AND n.nspname !~ '^pg_(toast|temp)'
      AND has_schema_privilege(n.oid, 'USAGE')
      AND p.prorettype NOT IN ('internal'::regtype, 'trigger'::regtype,
                               'event_trigger'::regtype, 'cstring'::regtype)
      AND NOT 'internal'::regtype = ANY (p.proargtypes::oid[])
      AND NOT 'cstring'::regtype = ANY (p.proargtypes::oid[])
      AND (n.nspname <> 'pg_catalog' OR (
            p.proname !~ '^(_|binary_upgrade)'
        AND NOT EXISTS (SELECT 1 FROM pg_operator o WHERE o.oprcode = p.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_cast c WHERE c.castfunc = p.oid)))
    ORDER BY n.nspname = 'pg_catalog', n.nspname, p.proname, 3
    LIMIT 5000";

const INDEXES: &str = "
    SELECT i.relname, pg_get_indexdef(x.indexrelid), x.indisunique, x.indisprimary
    FROM pg_index x
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = $1 AND t.relname = $2
    ORDER BY x.indisprimary DESC, i.relname";

fn relkinds(types: &[ObjectType]) -> Vec<&'static str> {
    let mut out = Vec::new();
    for t in types {
        match t {
            ObjectType::Table => out.extend(["r", "p"]),
            ObjectType::View => out.push("v"),
            ObjectType::MaterializedView => out.push("m"),
        }
    }
    out
}

fn as_count(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

/// `pg_get_triggerdef` without its `CREATE [CONSTRAINT] TRIGGER name ` prefix.
fn trigger_body(def: &str, quoted_name: &str) -> String {
    def.find(&format!("TRIGGER {quoted_name} "))
        .map(|at| def[at + "TRIGGER ".len() + quoted_name.len() + 1..].to_owned())
        .unwrap_or_else(|| def.to_owned())
}

fn index_body(def: &str) -> String {
    // "CREATE UNIQUE INDEX x ON s.t USING btree (a, b)" -> "btree (a, b)"
    def.split_once(" USING ")
        .map_or(def.to_owned(), |(_, rest)| rest.to_owned())
}

fn constraint_kind(contype: &str) -> &'static str {
    match contype {
        "p" => "primary key",
        "u" => "unique",
        "c" => "check",
        "x" => "exclusion",
        "f" => "foreign key",
        _ => "constraint",
    }
}

fn fk_action(code: &str) -> String {
    match code {
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    }
    .to_owned()
}

fn foreign_key(r: &Row) -> ForeignKeyDetail {
    ForeignKeyDetail {
        name: r.get(0),
        from_schema: r.get(1),
        from_table: r.get(2),
        from_columns: r.get(3),
        to_schema: r.get(4),
        to_table: r.get(5),
        to_columns: r.get(6),
        on_update: fk_action(&r.get::<_, String>(7)),
        on_delete: fk_action(&r.get::<_, String>(8)),
        deferrable: r.get(9),
    }
}

fn opt_count(n: Option<i64>) -> Option<u64> {
    n.and_then(|n| u64::try_from(n).ok())
}

/// Everything the table viewer shows for one object; `None` if it does not exist.
pub async fn details(
    client: &Client,
    object: &ObjectRef,
) -> Result<Option<ObjectDetails>, tokio_postgres::Error> {
    let Some(base) = client
        .query_opt(DETAIL_BASE, &[&object.schema, &object.name])
        .await?
    else {
        return Ok(None);
    };
    let oid: u32 = base.get(0);
    let columns = client
        .query(DETAIL_COLUMNS, &[&oid])
        .await?
        .iter()
        .map(|r| ColumnDetail {
            name: r.get(0),
            type_name: r.get(1),
            nullable: r.get(2),
            default: r.get(3),
            primary_key: r.get(4),
            identity: r.get(5),
            generated: r.get(6),
            comment: r.get(7),
        })
        .collect();
    let indexes = client
        .query(DETAIL_INDEXES, &[&oid])
        .await?
        .iter()
        .map(|r| IndexDetail {
            name: r.get(0),
            definition: index_body(&r.get::<_, String>(1)),
            unique: r.get(2),
            primary: r.get(3),
        })
        .collect();
    let constraints = client
        .query(DETAIL_CONSTRAINTS, &[&oid])
        .await?
        .iter()
        .map(|r| ConstraintDetail {
            name: r.get(0),
            kind: constraint_kind(&r.get::<_, String>(1)).to_owned(),
            definition: r.get(2),
        })
        .collect();
    let references = client
        .query(
            &format!("{FOREIGN_KEYS} AND k.conrelid = $1 ORDER BY k.conname"),
            &[&oid],
        )
        .await?
        .iter()
        .map(foreign_key)
        .collect();
    let referenced_by = client
        .query(
            &format!(
                "{FOREIGN_KEYS} AND k.confrelid = $1 ORDER BY n1.nspname, c1.relname, k.conname"
            ),
            &[&oid],
        )
        .await?
        .iter()
        .map(foreign_key)
        .collect();
    let triggers = client
        .query(DETAIL_TRIGGERS, &[&oid])
        .await?
        .iter()
        .map(|r| TriggerDetail {
            name: r.get(0),
            definition: trigger_body(&r.get::<_, String>(1), &r.get::<_, String>(3)),
            enabled: r.get(2),
        })
        .collect();
    Ok(Some(ObjectDetails {
        object: object.clone(),
        comment: base.get(2),
        columns,
        indexes,
        constraints,
        references,
        referenced_by,
        triggers,
        row_estimate: opt_count(base.get(3)),
        total_bytes: opt_count(base.get(4)),
    }))
}

/// Nodes for one constraint kind of a table.
async fn constraints(
    client: &Client,
    schema: &str,
    table: &str,
    contypes: &[&str],
    kind: MetaKind,
    prefix: &str,
) -> Result<Vec<MetaNode>, tokio_postgres::Error> {
    Ok(client
        .query(CONSTRAINTS, &[&schema, &table, &contypes])
        .await?
        .iter()
        .map(|r| {
            let name: String = r.get(0);
            let contype: String = r.get(1);
            MetaNode::new(format!("{prefix}:{name}"), kind, &name)
                .detail(Some(r.get(2)))
                .flag(contype == "p", "primary")
                .flag(contype == "u", "unique")
                .flag(contype == "x", "exclusion")
        })
        .collect())
}

pub async fn load(client: &Client, req: &Req) -> Result<Vec<MetaNode>, tokio_postgres::Error> {
    Ok(match req {
        Req::Schemas => client
            .query(SCHEMAS, &[])
            .await?
            .iter()
            .map(|r| {
                let name: String = r.get(0);
                MetaNode::new(format!("s:{name}"), MetaKind::Schema, &name)
                    .detail(r.get(1))
                    .children(Req::SchemaGroups { schema: name })
            })
            .collect(),

        Req::SchemaGroups { schema } => {
            let row = client.query_one(SCHEMA_COUNTS, &[schema]).await?;
            let group = |key: &str, label: &str, count: i64, types: Vec<ObjectType>| {
                MetaNode::new(key, MetaKind::Group, label)
                    .count(as_count(count))
                    .children(Req::Objects {
                        schema: schema.clone(),
                        types,
                    })
            };
            let mut groups = vec![
                group("g:tables", "Tables", row.get(0), vec![ObjectType::Table]),
                group("g:views", "Views", row.get(1), vec![ObjectType::View]),
            ];
            let matviews: i64 = row.get(2);
            if matviews > 0 {
                groups.push(group(
                    "g:matviews",
                    "Materialized views",
                    matviews,
                    vec![ObjectType::MaterializedView],
                ));
            }
            let routines: i64 = row.get(4);
            if routines > 0 {
                groups.push(
                    MetaNode::new("g:routines", MetaKind::Group, "Routines")
                        .count(as_count(routines))
                        .children(Req::Routines {
                            schema: schema.clone(),
                        }),
                );
            }
            let sequences: i64 = row.get(3);
            if sequences > 0 {
                groups.push(
                    MetaNode::new("g:sequences", MetaKind::Group, "Sequences")
                        .count(as_count(sequences))
                        .children(Req::Sequences {
                            schema: schema.clone(),
                        }),
                );
            }
            groups
        }

        Req::Objects { schema, types } => client
            .query(OBJECTS, &[schema, &relkinds(types)])
            .await?
            .iter()
            .map(|r| {
                let name: String = r.get(0);
                let relkind: String = r.get(1);
                let (kind, object_type) = match relkind.as_str() {
                    "v" => (MetaKind::View, ObjectType::View),
                    "m" => (MetaKind::MaterializedView, ObjectType::MaterializedView),
                    _ => (MetaKind::Table, ObjectType::Table),
                };
                MetaNode::new(format!("o:{name}"), kind, &name)
                    .detail(r.get(2))
                    .flag(relkind == "p", "partitioned")
                    .children(Req::ObjectGroups {
                        schema: schema.clone(),
                        name,
                        object_type,
                    })
            })
            .collect(),

        Req::ObjectGroups {
            schema,
            name,
            object_type,
        } => {
            let Some(row) = client.query_opt(OBJECT_COUNTS, &[schema, name]).await? else {
                return Ok(Vec::new()); // dropped since the parent was loaded; refresh the parent
            };
            let (schema, table) = (schema.clone(), name.clone());
            let columns = MetaNode::new("g:columns", MetaKind::Group, "Columns")
                .count(as_count(row.get(0)))
                .children(Req::Columns {
                    schema: schema.clone(),
                    table: table.clone(),
                });
            // Every other group shows only when it has something in it.
            let (s, t) = (schema.clone(), table.clone());
            let candidates: [(&str, &str, i64, Req); 5] = [
                (
                    "g:keys",
                    "Keys",
                    row.get(2),
                    Req::Keys {
                        schema: s.clone(),
                        table: t.clone(),
                    },
                ),
                (
                    "g:fks",
                    "Foreign keys",
                    row.get(3),
                    Req::ForeignKeys {
                        schema: s.clone(),
                        table: t.clone(),
                    },
                ),
                (
                    "g:checks",
                    "Checks",
                    row.get(4),
                    Req::Checks {
                        schema: s.clone(),
                        table: t.clone(),
                    },
                ),
                (
                    "g:indexes",
                    "Indexes",
                    row.get(1),
                    Req::Indexes {
                        schema: s.clone(),
                        table: t.clone(),
                    },
                ),
                (
                    "g:triggers",
                    "Triggers",
                    row.get(5),
                    Req::Triggers {
                        schema: s,
                        table: t,
                    },
                ),
            ];
            let allowed: &[&str] = match object_type {
                ObjectType::Table => &["g:keys", "g:fks", "g:checks", "g:indexes", "g:triggers"],
                ObjectType::View => &["g:triggers"],
                ObjectType::MaterializedView => &["g:indexes"],
            };
            let mut groups = vec![columns];
            for (key, label, count, request) in candidates {
                if count > 0 && allowed.contains(&key) {
                    groups.push(
                        MetaNode::new(key, MetaKind::Group, label)
                            .count(as_count(count))
                            .children(request),
                    );
                }
            }
            groups
        }

        Req::Keys { schema, table } => {
            constraints(client, schema, table, &["p", "u", "x"], MetaKind::Key, "k").await?
        }
        Req::ForeignKeys { schema, table } => {
            constraints(client, schema, table, &["f"], MetaKind::ForeignKey, "f").await?
        }
        Req::Checks { schema, table } => {
            constraints(client, schema, table, &["c"], MetaKind::Check, "ck").await?
        }

        Req::Triggers { schema, table } => client
            .query(TRIGGERS, &[schema, table])
            .await?
            .iter()
            .map(|r| {
                let name: String = r.get(0);
                let body = trigger_body(&r.get::<_, String>(1), &r.get::<_, String>(3));
                MetaNode::new(format!("t:{name}"), MetaKind::Trigger, &name)
                    .detail(Some(body))
                    .flag(!r.get::<_, bool>(2), "disabled")
            })
            .collect(),

        Req::Routines { schema } => client
            .query(ROUTINES, &[schema])
            .await?
            .iter()
            .map(|r| {
                let name: String = r.get(0);
                let args: String = r.get(1);
                let result: Option<String> = r.get(2);
                let prokind: String = r.get(3);
                let signature = match &result {
                    Some(result) => format!("({args}) → {result}"),
                    None => format!("({args})"),
                };
                // Overloads share a name; the identity arguments tell them apart.
                MetaNode::new(format!("r:{name}({args})"), MetaKind::Routine, &name)
                    .detail(Some(signature))
                    .flag(prokind == "p", "procedure")
                    .flag(prokind == "a", "aggregate")
                    .flag(prokind == "w", "window")
            })
            .collect(),

        Req::Sequences { schema } => client
            .query(SEQUENCES, &[schema])
            .await?
            .iter()
            .map(|r| {
                let name: String = r.get(0);
                let ty: String = r.get(1);
                let increment: i64 = r.get(2);
                let owner: Option<String> = r.get(3);
                let mut detail = ty;
                if increment != 1 {
                    detail.push_str(&format!(", increment {increment}"));
                }
                if let Some(owner) = owner {
                    detail.push_str(&format!(", owned by {owner}"));
                }
                MetaNode::new(format!("q:{name}"), MetaKind::Sequence, &name).detail(Some(detail))
            })
            .collect(),

        Req::Columns { schema, table } => client
            .query(COLUMNS, &[schema, table])
            .await?
            .iter()
            .map(|r| {
                let name: String = r.get(0);
                let ty: String = r.get(1);
                let default: Option<String> = r.get(3);
                let detail = match default {
                    Some(d) => format!("{ty} = {d}"),
                    None => ty,
                };
                MetaNode::new(format!("c:{name}"), MetaKind::Column, &name)
                    .detail(Some(detail))
                    .flag(r.get(4), "pk")
                    .flag(r.get(2), "not null")
            })
            .collect(),

        Req::Relations => client
            .query(RELATIONS, &[])
            .await?
            .iter()
            .map(|r| {
                let schema: String = r.get(0);
                let name: String = r.get(1);
                let relkind: String = r.get(2);
                let kind = match relkind.as_str() {
                    "v" => MetaKind::View,
                    "m" => MetaKind::MaterializedView,
                    _ => MetaKind::Table,
                };
                MetaNode::new(format!("{schema}.{name}"), kind, name).detail(Some(schema))
            })
            .collect(),

        Req::Functions => client
            .query(FUNCTIONS, &[])
            .await?
            .iter()
            .map(|r| {
                let schema: String = r.get(0);
                let name: String = r.get(1);
                let args: String = r.get(2);
                let result: Option<String> = r.get(3);
                let prokind: String = r.get(4);
                let signature = match &result {
                    Some(result) => format!("({args}) → {result}"),
                    None => format!("({args})"),
                };
                MetaNode::new(
                    format!("{schema}\u{1f}{name}({args})"),
                    MetaKind::Routine,
                    &name,
                )
                .detail(Some(signature))
                .flag(prokind == "p", "procedure")
                .flag(prokind == "a", "aggregate")
                .flag(prokind == "w", "window")
            })
            .collect(),

        Req::Indexes { schema, table } => client
            .query(INDEXES, &[schema, table])
            .await?
            .iter()
            .map(|r| {
                let name: String = r.get(0);
                let def: String = r.get(1);
                MetaNode::new(format!("i:{name}"), MetaKind::Index, &name)
                    .detail(Some(index_body(&def)))
                    .flag(r.get(3), "primary")
                    .flag(r.get::<_, bool>(2) && !r.get::<_, bool>(3), "unique")
            })
            .collect(),
    })
}
