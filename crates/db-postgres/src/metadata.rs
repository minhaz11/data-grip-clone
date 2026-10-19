//! PostgreSQL catalog queries for the lazy explorer tree. Every query is fixed text with bind
//! parameters; identifiers from the user never reach SQL text.

use quarry_db_core::{MetaKind, MetaNode, MetadataRequest as Req, ObjectType};
use tokio_postgres::Client;

const SCHEMAS: &str = "
    SELECT n.nspname, obj_description(n.oid, 'pg_namespace')
    FROM pg_namespace n
    WHERE n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'
      AND has_schema_privilege(n.oid, 'USAGE')
    ORDER BY n.nspname";

const SCHEMA_COUNTS: &str = "
    SELECT count(*) FILTER (WHERE c.relkind IN ('r', 'p')),
           count(*) FILTER (WHERE c.relkind = 'v'),
           count(*) FILTER (WHERE c.relkind = 'm')
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
           (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2";

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
            let mut groups = vec![
                MetaNode::new("g:columns", MetaKind::Group, "Columns")
                    .count(as_count(row.get(0)))
                    .children(Req::Columns {
                        schema: schema.clone(),
                        table: name.clone(),
                    }),
            ];
            if *object_type != ObjectType::View {
                groups.push(
                    MetaNode::new("g:indexes", MetaKind::Group, "Indexes")
                        .count(as_count(row.get(1)))
                        .children(Req::Indexes {
                            schema: schema.clone(),
                            table: name.clone(),
                        }),
                );
            }
            groups
        }

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

        Req::Indexes { schema, table } => client
            .query(INDEXES, &[schema, table])
            .await?
            .iter()
            .map(|r| {
                let name: String = r.get(0);
                let def: String = r.get(1);
                // "CREATE UNIQUE INDEX x ON s.t USING btree (a, b)" -> "btree (a, b)"
                let short = def
                    .split_once(" USING ")
                    .map_or(def.clone(), |(_, rest)| rest.to_owned());
                MetaNode::new(format!("i:{name}"), MetaKind::Index, &name)
                    .detail(Some(short))
                    .flag(r.get(3), "primary")
                    .flag(r.get::<_, bool>(2) && !r.get::<_, bool>(3), "unique")
            })
            .collect(),
    })
}
