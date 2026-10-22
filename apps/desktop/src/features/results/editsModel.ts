import type { Cell, EditTarget, RowChange } from '../../ipc/types';

/** Pending edits of one result, keyed by the row's primary-key values (stable across paging). */
export interface PendingEdits {
  updates: Record<
    string,
    { key: Cell[]; set: Record<number, Cell>; original: Record<number, Cell> }
  >;
  deletes: Record<string, Cell[]>;
  inserts: { id: string; values: Record<number, Cell> }[];
}

export const NO_EDITS: PendingEdits = { updates: {}, deletes: {}, inserts: [] };

/** A copy of `record` without `key`. */
function omit<T>(
  record: Record<string | number, T>,
  key: string | number,
): Record<string | number, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== String(key)));
}

export function keyOf(target: EditTarget, cells: Cell[]): Cell[] {
  return target.key.map((i) => cells[i] ?? null);
}

/** `null` when the row cannot be identified (a key value is NULL or not loaded). */
export function rowKey(target: EditTarget, cells: Cell[] | undefined): string | null {
  if (!cells) return null;
  const key = keyOf(target, cells);
  return key.some((k) => k === null) ? null : JSON.stringify(key);
}

/** Sets one cell of an existing row; editing back to the original value drops the change. */
export function setCell(
  edits: PendingEdits,
  target: EditTarget,
  cells: Cell[],
  column: number,
  value: Cell,
): PendingEdits {
  const id = rowKey(target, cells);
  if (id === null || !target.columns[column]) return edits;
  const current = edits.updates[id] ?? { key: keyOf(target, cells), set: {}, original: {} };
  const original = column in current.original ? current.original[column] : (cells[column] ?? null);
  const back = value === original;
  const set = back ? omit(current.set, column) : { ...current.set, [column]: value };
  const originals = back
    ? omit(current.original, column)
    : { ...current.original, [column]: original ?? null };
  const updates =
    Object.keys(set).length === 0
      ? omit(edits.updates, id)
      : { ...edits.updates, [id]: { key: current.key, set, original: originals } };
  return { ...edits, updates } as PendingEdits;
}

export function toggleDelete(edits: PendingEdits, target: EditTarget, cells: Cell[]): PendingEdits {
  const id = rowKey(target, cells);
  if (id === null) return edits;
  const deletes =
    id in edits.deletes
      ? omit(edits.deletes, id)
      : { ...edits.deletes, [id]: keyOf(target, cells) };
  return { ...edits, deletes } as PendingEdits;
}

export function addInsert(edits: PendingEdits, id: string): PendingEdits {
  return { ...edits, inserts: [...edits.inserts, { id, values: {} }] };
}

export function setInsert(
  edits: PendingEdits,
  id: string,
  column: number,
  value: Cell,
): PendingEdits {
  return {
    ...edits,
    inserts: edits.inserts.map((r) =>
      r.id === id ? { ...r, values: { ...r.values, [column]: value } } : r,
    ),
  };
}

export function removeInsert(edits: PendingEdits, id: string): PendingEdits {
  return { ...edits, inserts: edits.inserts.filter((r) => r.id !== id) };
}

export function pendingCount(e: PendingEdits): number {
  const updates = Object.keys(e.updates).filter((k) => !(k in e.deletes)).length;
  return updates + Object.keys(e.deletes).length + e.inserts.length;
}

const values = (r: Record<number, Cell>) =>
  Object.entries(r)
    .map(([column, value]) => ({ column: Number(column), value }))
    .sort((a, b) => a.column - b.column);

/** Deterministic change list: updates, then deletes, then inserts. A deleted row's updates are dropped. */
export function toChanges(e: PendingEdits): RowChange[] {
  const out: RowChange[] = [];
  for (const [id, u] of Object.entries(e.updates)) {
    if (!(id in e.deletes))
      out.push({ kind: 'update', key: u.key, set: values(u.set), original: values(u.original) });
  }
  for (const key of Object.values(e.deletes)) out.push({ kind: 'delete', key });
  for (const r of e.inserts) out.push({ kind: 'insert', values: values(r.values) });
  return out;
}
