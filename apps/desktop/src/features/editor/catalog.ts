import { backend } from '../../ipc/client';
import type { ForeignKeyDetail, MetaNode } from '../../ipc/types';
import type { TableRef } from '../../lib/sql/completionContext';

/**
 * Completion catalog per data source: every table/view (one query), plus columns fetched per
 * table on demand. Cached until the source's session changes; failures yield empty results so
 * completion degrades to keywords instead of erroring.
 */
const relations = new Map<string, Promise<MetaNode[]>>();
const columns = new Map<string, Promise<MetaNode[]>>();
const functions = new Map<string, Promise<MetaNode[]>>();
const links = new Map<string, Promise<ForeignKeyDetail[]>>();

export function catalogRelations(sourceId: string): Promise<MetaNode[]> {
  let p = relations.get(sourceId);
  if (!p) {
    p = backend.metadataChildren(sourceId, { level: 'relations' }).catch(() => {
      relations.delete(sourceId); // retry next time (e.g. after connecting)
      return [];
    });
    relations.set(sourceId, p);
  }
  return p;
}

export function catalogColumns(
  sourceId: string,
  schema: string,
  table: string,
): Promise<MetaNode[]> {
  const key = `${sourceId}\u001f${schema}\u001f${table}`;
  let p = columns.get(key);
  if (!p) {
    p = backend.metadataChildren(sourceId, { level: 'columns', schema, table }).catch(() => {
      columns.delete(key);
      return [];
    });
    columns.set(key, p);
  }
  return p;
}

/** Functions callable from SQL (user schemas first), for completion. */
export function catalogFunctions(sourceId: string): Promise<MetaNode[]> {
  let p = functions.get(sourceId);
  if (!p) {
    p = backend.metadataChildren(sourceId, { level: 'functions' }).catch(() => {
      functions.delete(sourceId);
      return [];
    });
    functions.set(sourceId, p);
  }
  return p;
}

/** Foreign keys of a table in both directions (it references, it is referenced by). */
export function catalogLinks(
  sourceId: string,
  schema: string,
  table: string,
): Promise<ForeignKeyDetail[]> {
  const key = `${sourceId}\u001f${schema}\u001f${table}`;
  let p = links.get(key);
  if (!p) {
    p = backend
      .objectDetails(sourceId, { schema, name: table, objectType: 'table' })
      .then((d) => (d ? [...d.references, ...d.referencedBy] : []))
      .catch(() => {
        links.delete(key);
        return [];
      });
    links.set(key, p);
  }
  return p;
}

export function resetCatalog(sourceId?: string) {
  for (const map of [relations, columns, functions, links] as Map<string, unknown>[]) {
    for (const k of [...map.keys()])
      if (!sourceId || k === sourceId || k.startsWith(`${sourceId}\u001f`)) map.delete(k);
  }
}

/**
 * The relation a reference points at: the exact schema if given, else the first schema of the
 * search path that has it (the console's schema, then `public`), else a unique match.
 */
export function resolveRelation(
  all: MetaNode[],
  ref: Pick<TableRef, 'schema' | 'table'>,
  searchPath: string[] = ['public'],
): MetaNode | undefined {
  const named = all.filter((r) => r.name === ref.table);
  if (ref.schema) return named.find((r) => r.detail === ref.schema);
  for (const schema of searchPath) {
    const found = named.find((r) => r.detail === schema);
    if (found) {
      return found;
    }
  }
  return named.length === 1 ? named[0] : undefined;
}

/** The search path a console resolves names with: its schema (if set), then `public`. */
export function searchPathOf(schema: string | null | undefined): string[] {
  return schema && schema !== 'public' ? [schema, 'public'] : ['public'];
}
