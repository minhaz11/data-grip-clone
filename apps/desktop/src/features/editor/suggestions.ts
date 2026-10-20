import type { MetaNode } from '../../ipc/types';
import type { CompletionContext, TableRef } from '../../lib/sql/completionContext';
import { PG_KEYWORDS } from '../../lib/sql/keywords';
import { resolveRelation } from './catalog';

export type SuggestionKind = 'keyword' | 'schema' | 'table' | 'view' | 'column';

export interface Suggestion {
  label: string;
  kind: SuggestionKind;
  insertText: string;
  detail?: string;
  /** Lower sorts first. */
  rank: number;
}

export interface CatalogAccess {
  relations: MetaNode[];
  columnsOf(relation: MetaNode): Promise<MetaNode[]>;
}

/** Quotes an identifier only when PostgreSQL would need it. */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !PG_KEYWORDS.includes(name.toUpperCase())
    ? name
    : `"${name.replace(/"/g, '""')}"`;
}

const relationKind = (n: MetaNode): SuggestionKind =>
  n.kind === 'view' || n.kind === 'materialized_view' ? 'view' : 'table';

function relationSuggestion(r: MetaNode, all: MetaNode[], rank: number): Suggestion {
  // Qualify when outside `public` or when the bare name would be ambiguous.
  const ambiguous = all.filter((o) => o.name === r.name).length > 1;
  const qualify = r.detail !== 'public' || ambiguous;
  return {
    label: r.name,
    kind: relationKind(r),
    insertText:
      qualify && r.detail ? `${quoteIdent(r.detail)}.${quoteIdent(r.name)}` : quoteIdent(r.name),
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

/** Suggestions for one completion request; pure apart from column lookups through `catalog`. */
export async function buildSuggestions(
  context: CompletionContext,
  tables: TableRef[],
  catalog: CatalogAccess,
): Promise<Suggestion[]> {
  const { relations } = catalog;
  const schemas = [...new Set(relations.map((r) => r.detail).filter((s): s is string => !!s))];

  if (context.kind === 'members') {
    const q = context.qualifier;
    // alias.col or table.col
    const ref =
      tables.find((t) => t.alias === q) ??
      tables.find((t) => !t.alias && t.table === q) ??
      tables.find((t) => t.table === q);
    const rel = ref ? resolveRelation(relations, ref) : undefined;
    if (rel) return (await catalog.columnsOf(rel)).map((c, i) => columnSuggestion(c, rel.name, i));
    // schema.relation
    if (schemas.includes(q)) {
      return relations
        .filter((r) => r.detail === q)
        .map((r) => ({ ...relationSuggestion(r, relations, 0), insertText: quoteIdent(r.name) }));
    }
    return [];
  }

  const relationItems = relations.map((r) =>
    relationSuggestion(r, relations, r.detail === 'public' ? 0 : 1),
  );
  const schemaItems: Suggestion[] = schemas.map((s) => ({
    label: s,
    kind: 'schema',
    insertText: quoteIdent(s),
    detail: 'schema',
    rank: 2,
  }));
  if (context.kind === 'relations') return [...relationItems, ...schemaItems];

  const columnItems: Suggestion[] = [];
  for (const t of tables) {
    const rel = resolveRelation(relations, t);
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
    ...schemaItems,
    ...keywordItems,
  ];
}
