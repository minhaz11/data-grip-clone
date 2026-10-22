import type { ForeignKeyDetail, MetaNode } from '../../ipc/types';
import type { CompletionContext, TableRef } from '../../lib/sql/completionContext';
import { PG_KEYWORDS } from '../../lib/sql/keywords';
import { resolveRelation } from './catalog';

export type SuggestionKind =
  'keyword' | 'schema' | 'table' | 'view' | 'column' | 'function' | 'join';

export interface Suggestion {
  label: string;
  kind: SuggestionKind;
  insertText: string;
  /** `insertText` is a snippet (`$0` marks where the caret goes). */
  snippet?: boolean;
  detail?: string;
  /** Lower sorts first. */
  rank: number;
}

export interface CatalogAccess {
  relations: MetaNode[];
  columnsOf(relation: MetaNode): Promise<MetaNode[]>;
  /** Callable functions (`MetadataRequest` level `functions`). */
  functions?: MetaNode[];
  /** Foreign keys of a relation in both directions, for JOIN suggestions. */
  linksOf?(relation: MetaNode): Promise<ForeignKeyDetail[]>;
  /** Schemas unqualified names resolve in (the console's schema first); default `public`. */
  searchPath?: string[];
}

/** Quotes an identifier only when PostgreSQL would need it. */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !PG_KEYWORDS.includes(name.toUpperCase())
    ? name
    : `"${name.replace(/"/g, '""')}"`;
}

/**
 * How well `word` matches `label` (lower is better), or `null` for no match: exact prefix 0,
 * initials of its words 1 (`oi` for `order_items`), the start of a later word 2, letters in
 * order 3.
 */
export function fuzzyScore(word: string, label: string): number | null {
  if (!word) {
    return 0;
  }
  const w = word.toLowerCase();
  const l = label.toLowerCase();
  if (l.startsWith(w)) {
    return 0;
  }
  const words = label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_$.-]+/)
    .filter(Boolean);
  if (
    words
      .map((p) => p[0])
      .join('')
      .startsWith(w)
  ) {
    return 1;
  }
  if (words.slice(1).some((p) => p.startsWith(w))) {
    return 2;
  }
  let at = 0;
  for (const ch of l) {
    if (ch === w[at]) {
      at += 1;
      if (at === w.length) {
        return 3;
      }
    }
  }
  return null;
}

/** Keeps suggestions matching the typed word, best matches first (stable within a score). */
export function rankByWord(items: Suggestion[], word: string): Suggestion[] {
  return items
    .map((item, order) => ({ item, order, score: fuzzyScore(word, item.label) }))
    .filter((x): x is { item: Suggestion; order: number; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((x) => x.item);
}

const relationKind = (n: MetaNode): SuggestionKind =>
  n.kind === 'view' || n.kind === 'materialized_view' ? 'view' : 'table';

/** A relation as SQL: bare when the search path finds it unambiguously, else qualified. */
function relationText(r: MetaNode, all: MetaNode[], searchPath: string[]): string {
  const ambiguous = all.filter((o) => o.name === r.name).length > 1;
  const bare = !!r.detail && searchPath.includes(r.detail) && !ambiguous;
  return !bare && r.detail ? `${quoteIdent(r.detail)}.${quoteIdent(r.name)}` : quoteIdent(r.name);
}

function relationSuggestion(
  r: MetaNode,
  all: MetaNode[],
  searchPath: string[],
  rank: number,
): Suggestion {
  return {
    label: r.name,
    kind: relationKind(r),
    insertText: relationText(r, all, searchPath),
    detail: r.detail ? `${r.detail} · ${r.kind.replace('_', ' ')}` : r.kind,
    rank,
  };
}

const columnSuggestion = (c: MetaNode, owner: string, rank: number): Suggestion => ({
  label: c.name,
  kind: 'column',
  insertText: quoteIdent(c.name),
  detail: [owner, c.detail].filter(Boolean).join(' · '),
  rank,
});

/** Schema of a function node (`key` is `schema\u001fname(args)`). */
function functionSchema(f: MetaNode): string {
  return f.key.split('\u001f')[0] ?? '';
}

/** One suggestion per function name and schema; overloads are counted in the detail. */
function functionSuggestions(fns: MetaNode[], searchPath: string[], rank: number): Suggestion[] {
  const groups = new Map<string, MetaNode[]>();
  for (const f of fns) {
    const key = `${functionSchema(f)}\u001f${f.name}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()].map((overloads) => {
    const f = overloads[0] as MetaNode;
    const schema = functionSchema(f);
    const bare = schema === 'pg_catalog' || searchPath.includes(schema);
    const name = bare ? quoteIdent(f.name) : `${quoteIdent(schema)}.${quoteIdent(f.name)}`;
    const more = overloads.length > 1 ? ` (+${overloads.length - 1} more)` : '';
    return {
      label: f.name,
      kind: 'function' as const,
      insertText: `${name}($0)`,
      snippet: true,
      detail: `${schema === 'pg_catalog' ? '' : `${schema} · `}${f.detail ?? ''}${more}`,
      rank: schema === 'pg_catalog' ? rank + 1 : rank,
    };
  });
}

/** A short alias from a table name's words (`order_items` → `oi`), unused in the statement. */
function aliasFor(table: string, taken: Set<string>): string {
  const base =
    table
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((p) => p[0])
      .join('') || 't';
  let alias = PG_KEYWORDS.includes(base.toUpperCase()) ? `${base}1` : base;
  for (let n = 2; taken.has(alias); n++) {
    alias = `${base}${n}`;
  }
  return alias;
}

/**
 * `JOIN` completions from foreign keys between the statement's tables and others, in both
 * directions: `customers c ON c.id = o.customer_id`.
 */
async function joinSuggestions(
  tables: TableRef[],
  catalog: CatalogAccess,
  searchPath: string[],
): Promise<Suggestion[]> {
  if (!catalog.linksOf) {
    return [];
  }
  const taken = new Set(tables.map((t) => t.alias ?? t.table));
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const t of tables) {
    const rel = resolveRelation(catalog.relations, t, searchPath);
    if (!rel) {
      continue;
    }
    const left = quoteIdent(t.alias ?? t.table);
    for (const fk of await catalog.linksOf(rel)) {
      const outgoing = fk.fromSchema === rel.detail && fk.fromTable === rel.name;
      const [schema, table, theirs, ours] = outgoing
        ? [fk.toSchema, fk.toTable, fk.toColumns, fk.fromColumns]
        : [fk.fromSchema, fk.fromTable, fk.fromColumns, fk.toColumns];
      const target = catalog.relations.find((r) => r.detail === schema && r.name === table) ?? {
        key: `${schema}.${table}`,
        kind: 'table' as const,
        name: table,
        detail: schema,
      };
      const alias = aliasFor(table, taken);
      const on = theirs
        .map((c, i) => `${alias}.${quoteIdent(c)} = ${left}.${quoteIdent(ours[i] ?? '')}`)
        .join(' AND ');
      const text = `${relationText(target, catalog.relations, searchPath)} ${alias} ON ${on}`;
      if (seen.has(text)) {
        continue;
      }
      seen.add(text);
      out.push({
        label: `${table} ${alias} ON ${on}`,
        kind: 'join',
        insertText: text,
        detail: `foreign key ${fk.name}`,
        rank: -1,
      });
    }
  }
  return out;
}

/** Suggestions for one completion request; pure apart from catalog lookups through `catalog`. */
export async function buildSuggestions(
  context: CompletionContext,
  tables: TableRef[],
  catalog: CatalogAccess,
): Promise<Suggestion[]> {
  return rankByWord(await allSuggestions(context, tables, catalog), context.word);
}

async function allSuggestions(
  context: CompletionContext,
  tables: TableRef[],
  catalog: CatalogAccess,
): Promise<Suggestion[]> {
  const { relations } = catalog;
  const searchPath = catalog.searchPath ?? ['public'];
  const functions = catalog.functions ?? [];
  const schemas = [...new Set(relations.map((r) => r.detail).filter((s): s is string => !!s))];
  const preferred = (r: MetaNode) => (r.detail && searchPath.includes(r.detail) ? 0 : 1);

  if (context.kind === 'members') {
    const q = context.qualifier;
    // alias.col or table.col
    const ref =
      tables.find((t) => t.alias === q) ??
      tables.find((t) => !t.alias && t.table === q) ??
      tables.find((t) => t.table === q);
    const rel = ref ? resolveRelation(relations, ref, searchPath) : undefined;
    if (rel) return (await catalog.columnsOf(rel)).map((c, i) => columnSuggestion(c, rel.name, i));
    // schema.relation or schema.function
    if (schemas.includes(q) || functions.some((f) => functionSchema(f) === q)) {
      return [
        ...relations
          .filter((r) => r.detail === q)
          .map((r) => ({
            ...relationSuggestion(r, relations, searchPath, 0),
            insertText: quoteIdent(r.name),
          })),
        ...functionSuggestions(
          functions.filter((f) => functionSchema(f) === q),
          [q],
          1,
        ),
      ];
    }
    return [];
  }

  const relationItems = relations.map((r) =>
    relationSuggestion(r, relations, searchPath, preferred(r)),
  );
  const schemaItems: Suggestion[] = schemas.map((s) => ({
    label: s,
    kind: 'schema',
    insertText: quoteIdent(s),
    detail: 'schema',
    rank: 2,
  }));
  if (context.kind === 'relations') {
    const joins = context.join ? await joinSuggestions(tables, catalog, searchPath) : [];
    return [...joins, ...relationItems, ...schemaItems];
  }

  const columnItems: Suggestion[] = [];
  for (const t of tables) {
    const rel = resolveRelation(relations, t, searchPath);
    if (rel)
      columnItems.push(
        ...(await catalog.columnsOf(rel)).map((c) => columnSuggestion(c, t.alias ?? rel.name, 0)),
      );
  }
  const keywordItems: Suggestion[] = PG_KEYWORDS.map((k) => ({
    label: k,
    kind: 'keyword',
    insertText: k,
    rank: 3,
  }));
  return [
    ...columnItems,
    ...relationItems.map((r) => ({ ...r, rank: r.rank + 1 })),
    ...functionSuggestions(functions, searchPath, 2),
    ...schemaItems,
    ...keywordItems,
  ];
}
