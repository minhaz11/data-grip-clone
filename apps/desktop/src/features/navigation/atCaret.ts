import { useSessions } from '../connections/sessionsStore';
import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { normalizeIdent, tablesInStatement, type TableRef } from '../../lib/sql/completionContext';
import { statementAt } from '../../lib/sql/statements';
import { activeEditor } from '../editor/editorHandle';
import { catalogColumns, catalogObjects } from '../editor/catalog';
import { fromCatalogNode, openDefault, revealInTree, type CatalogObject } from './objects';

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const CHAIN = new RegExp(String.raw`${IDENT}(?:\s*\.\s*${IDENT})*`, 'g');
const PART = new RegExp(IDENT, 'g');

/** The dotted name under `offset` (`o.id`, `shop.orders`), split, and which part holds it. */
export function nameAt(
  text: string,
  offset: number,
): { parts: string[]; index: number; call: boolean } | null {
  for (const m of text.matchAll(CHAIN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (offset < start || offset > end) {
      continue;
    }
    const parts: string[] = [];
    let index = 0;
    for (const p of m[0].matchAll(PART)) {
      const at = start + (p.index ?? 0);
      if (offset >= at && offset <= at + p[0].length) {
        index = parts.length;
      }
      parts.push(normalizeIdent(p[0]));
    }
    const call = /^\s*\(/.test(text.slice(end));
    return { parts, index, call };
  }
  return null;
}

/**
 * The object a name under the caret refers to, by the statement's own table references first
 * (aliases, then table names), then the catalog: the console's schema, `public`, then a unique
 * match anywhere. A column resolves to its table.
 */
export async function resolveAt(
  sourceId: string,
  statement: string,
  offsetInStatement: number,
  schema: string | null,
): Promise<CatalogObject | null> {
  const at = nameAt(statement, offsetInStatement);
  if (!at) {
    return null;
  }
  const objects = (await catalogObjects(sourceId)).map((n) => fromCatalogNode(sourceId, n));
  const searchPath = [...(schema ? [schema] : []), 'public'];
  const find = (name: string, inSchema?: string, routine = false) => {
    const named = objects.filter((o) => o.name === name && (o.kind === 'routine') === routine);
    if (inSchema) {
      return named.find((o) => o.schema === inSchema) ?? null;
    }
    for (const s of searchPath) {
      const found = named.find((o) => o.schema === s);
      if (found) {
        return found;
      }
    }
    return named.length === 1 ? (named[0] ?? null) : null;
  };
  const refs = tablesInStatement(statement);
  const byAlias = (word: string): TableRef | undefined =>
    refs.find((r) => r.alias === word) ?? refs.find((r) => !r.alias && r.table === word);
  const tableOf = (r: TableRef) => find(r.table, r.schema);

  const { parts, index, call } = at;
  if (call && parts.length <= 2) {
    const name = parts[parts.length - 1] ?? '';
    return find(name, parts.length === 2 ? parts[0] : undefined, true);
  }
  if (parts.length >= 2) {
    // `alias.column` or `table.column`: the table, wherever the caret is in the name.
    const ref = parts.length === 2 ? byAlias(parts[0] ?? '') : undefined;
    if (ref) {
      return tableOf(ref);
    }
    // `schema.table`, or `schema.table.column`.
    return find(parts[1] ?? '', parts[0]);
  }
  const word = parts[index] ?? '';
  const ref = byAlias(word);
  if (ref) {
    return tableOf(ref);
  }
  const direct = find(word);
  if (direct) {
    return direct;
  }
  // A bare column: the first table of the statement that has it.
  for (const r of refs) {
    const table = tableOf(r);
    if (
      table &&
      (await catalogColumns(sourceId, table.schema, table.name)).some((c) => c.name === word)
    ) {
      return table;
    }
  }
  return null;
}

/** The object under the active console's caret, or a message saying why there is none. */
export async function objectAtCaret(): Promise<CatalogObject | string> {
  const ws = useWorkspace.getState();
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
  const editor = activeEditor();
  if (!isConsole(tab) || !editor) {
    return 'Go to DDL works in a console.';
  }
  if (!tab.sourceId) {
    return 'Choose a data source for this console first.';
  }
  if (useSessions.getState().byId[tab.sourceId]?.state !== 'connected') {
    return 'Connect to the data source first: names are looked up in its catalog.';
  }
  const text = editor.getText();
  const caret = editor.getCaret();
  const span = statementAt(text, caret);
  const start = span?.start ?? 0;
  const statement = text.slice(start, span ? Math.max(span.end, caret) : text.length);
  const found = await resolveAt(tab.sourceId, statement, caret - start, tab.schema ?? null);
  return found ?? 'No table, view, routine or sequence at the caret.';
}

/** Opens the object under the caret (table viewer, or DDL for routines and sequences). */
export async function goToDdlAtCaret(): Promise<string | null> {
  const found = await objectAtCaret();
  if (typeof found === 'string') {
    return found;
  }
  openDefault(found);
  return null;
}

export async function revealAtCaret(): Promise<string | null> {
  const found = await objectAtCaret();
  if (typeof found === 'string') {
    return found;
  }
  revealInTree(found);
  return null;
}
