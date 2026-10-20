import { backend } from '../../ipc/client';
import type { MetaNode } from '../../ipc/types';
import type { TableRef } from '../../lib/sql/completionContext';

/**
 * Completion catalog per data source: every table/view (one query), plus columns fetched per
 * table on demand. Cached until the source's session changes; failures yield empty results so
 * completion degrades to keywords instead of erroring.
 */
const relations = new Map<string, Promise<MetaNode[]>>();
const columns = new Map<string, Promise<MetaNode[]>>();

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

export function resetCatalog(sourceId?: string) {
  for (const map of [relations, columns]) {
    for (const k of [...map.keys()])
      if (!sourceId || k === sourceId || k.startsWith(`${sourceId}\u001f`)) map.delete(k);
  }
}

/** The relation a reference points at: exact schema if given, else `public`, else a unique match. */
export function resolveRelation(
  all: MetaNode[],
  ref: Pick<TableRef, 'schema' | 'table'>,
): MetaNode | undefined {
  const named = all.filter((r) => r.name === ref.table);
  if (ref.schema) return named.find((r) => r.detail === ref.schema);
  return named.find((r) => r.detail === 'public') ?? (named.length === 1 ? named[0] : undefined);
}
