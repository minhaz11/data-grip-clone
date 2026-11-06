import { useWorkspace } from '../../app/workspaceStore';
import type { DdlObject, MetaKind, MetaNode, ObjectRef, ObjectType } from '../../ipc/types';
import { SEP } from '../explorer/treeModel';
import { useMetadata } from '../explorer/metadataStore';

/** A database object found by name (palette, Go to DDL). */
export interface CatalogObject {
  sourceId: string;
  schema: string;
  name: string;
  kind: MetaKind;
  /** Identity arguments of a routine (`integer, text`). */
  args?: string;
}

const RELATION_TYPES: Partial<Record<MetaKind, ObjectType>> = {
  table: 'table',
  view: 'view',
  materialized_view: 'materialized_view',
};

/** Reads a node of the `catalog` metadata level (key `schema\u001f<r:name(args)|o:name|q:name>`). */
export function fromCatalogNode(sourceId: string, node: MetaNode): CatalogObject {
  const schema = node.detail ?? '';
  const key = node.key.slice(node.key.indexOf(SEP) + 1);
  const args = node.kind === 'routine' ? key.slice(`r:${node.name}(`.length, -1) : undefined;
  return { sourceId, schema, name: node.name, kind: node.kind, args };
}

export function isRelation(o: CatalogObject): boolean {
  return RELATION_TYPES[o.kind] !== undefined;
}

export function objectRef(o: CatalogObject): ObjectRef | null {
  const objectType = RELATION_TYPES[o.kind];
  return objectType ? { schema: o.schema, name: o.name, objectType } : null;
}

export function ddlObject(o: CatalogObject): DdlObject | null {
  if (isRelation(o)) {
    return { kind: 'relation', schema: o.schema, name: o.name };
  }
  if (o.kind === 'routine') {
    return { kind: 'routine', schema: o.schema, name: o.name, args: o.args ?? '' };
  }
  if (o.kind === 'sequence') {
    return { kind: 'sequence', schema: o.schema, name: o.name };
  }
  return null;
}

export function qualifiedName(o: CatalogObject): string {
  return o.kind === 'routine' ? `${o.schema}.${o.name}(${o.args ?? ''})` : `${o.schema}.${o.name}`;
}

/** Tables, views and materialized views open in the table viewer; other objects as DDL. */
export function openDefault(o: CatalogObject): void {
  const ref = objectRef(o);
  if (ref) {
    useWorkspace.getState().openObject(o.sourceId, ref);
  } else {
    showDdl(o);
  }
}

export function showDdl(o: CatalogObject): void {
  const object = ddlObject(o);
  if (object) {
    void useWorkspace.getState().openDdl(o.sourceId, [object], qualifiedName(o));
  }
}

export function openData(o: CatalogObject): boolean {
  const ref = objectRef(o);
  if (!ref) {
    return false;
  }
  useWorkspace.getState().openData(o.sourceId, ref);
  return true;
}

const GROUP_OF: Partial<Record<MetaKind, string>> = {
  table: 'g:tables',
  view: 'g:views',
  materialized_view: 'g:matviews',
  routine: 'g:routines',
  sequence: 'g:sequences',
};

/** Tree keys from the data source down to the object, as the explorer builds them. */
export function treePath(o: CatalogObject): string[] {
  const group = GROUP_OF[o.kind];
  const leaf =
    o.kind === 'routine'
      ? `r:${o.name}(${o.args ?? ''})`
      : o.kind === 'sequence'
        ? `q:${o.name}`
        : `o:${o.name}`;
  const parts = [o.sourceId, `s:${o.schema}`, ...(group ? [group, leaf] : [])];
  return parts.map((_, i) => parts.slice(0, i + 1).join(SEP));
}

/** Shows the explorer, expands the way to the object and selects it. */
export function revealInTree(o: CatalogObject): void {
  useWorkspace.getState().setExplorerCollapsed(false);
  useMetadata.getState().requestReveal(o.sourceId, treePath(o));
}
