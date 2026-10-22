import type { Cell, EditTarget, RowChange } from '../../ipc/types';

/** Pending edits of one result, keyed by the row's primary-key values (stable across paging). */
export interface PendingEdits {
  updates: Record<
    string,
    {
      key: Cell[];
      set: Record<number, Cell>;
      original: Record<number, Cell>;
      /** Columns set to their default (`SET col = DEFAULT`). */
      defaults?: number[];
    }
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
  const defaults = (current.defaults ?? []).filter((c) => c !== column);
  // Originals of columns no longer changed are pruned by `withUpdate`.
  const originals = { ...current.original, [column]: original ?? null };
  return withUpdate(edits, id, { key: current.key, set, original: originals, defaults });
}

type RowUpdate = PendingEdits['updates'][string];

/** Stores an update, or drops it when nothing is left to change. */
function withUpdate(edits: PendingEdits, id: string, update: RowUpdate): PendingEdits {
  const defaults = update.defaults ?? [];
  if (Object.keys(update.set).length === 0 && defaults.length === 0) {
    return { ...edits, updates: omit(edits.updates, id) } as PendingEdits;
  }
  const original = Object.fromEntries(
    Object.entries(update.original).filter(
      ([c]) => Number(c) in update.set || defaults.includes(Number(c)),
    ),
  );
  const next = {
    key: update.key,
    set: update.set,
    original,
    ...(defaults.length ? { defaults } : {}),
  };
  return { ...edits, updates: { ...edits.updates, [id]: next } };
}

/** Sets one cell of an existing row to the column default. */
export function setDefault(
  edits: PendingEdits,
  target: EditTarget,
  cells: Cell[],
  column: number,
): PendingEdits {
  const id = rowKey(target, cells);
  if (id === null || !target.columns[column]) {
    return edits;
  }
  const current = edits.updates[id] ?? { key: keyOf(target, cells), set: {}, original: {} };
  const original = column in current.original ? current.original[column] : (cells[column] ?? null);
  const defaults = [...(current.defaults ?? []).filter((c) => c !== column), column];
  return withUpdate(edits, id, {
    key: current.key,
    set: omit(current.set, column) as Record<number, Cell>,
    original: { ...current.original, [column]: original ?? null },
    defaults,
  });
}

/** Leaves a column of an inserted row to its default (drops the typed value). */
export function unsetInsert(edits: PendingEdits, id: string, column: number): PendingEdits {
  return {
    ...edits,
    inserts: edits.inserts.map((r) =>
      r.id === id ? { ...r, values: omit(r.values, column) as Record<number, Cell> } : r,
    ),
  };
}

/** Drops every pending change of the given existing rows and inserted rows. */
export function revertRows(
  edits: PendingEdits,
  target: EditTarget,
  rows: Cell[][],
  insertIds: string[],
): PendingEdits {
  const ids = new Set(rows.map((cells) => rowKey(target, cells)).filter((k) => k !== null));
  const keep = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([k]) => !ids.has(k)));
  return {
    updates: keep(edits.updates),
    deletes: keep(edits.deletes),
    inserts: edits.inserts.filter((r) => !insertIds.includes(r.id)),
  };
}

/**
 * New rows copying the editable values of `rows`. Primary key columns are left to their
 * defaults, so a clone does not collide with its original.
 */
export function cloneRows(
  edits: PendingEdits,
  target: EditTarget,
  rows: Cell[][],
  newId: (n: number) => string,
): PendingEdits {
  const inserts = rows.map((cells, n) => ({
    id: newId(n),
    values: Object.fromEntries(
      cells
        .map((v, i) => [i, v] as const)
        .filter(([i]) => target.columns[i] && !target.key.includes(i)),
    ) as Record<number, Cell>,
  }));
  return { ...edits, inserts: [...edits.inserts, ...inserts] };
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
      out.push({
        kind: 'update',
        key: u.key,
        set: values(u.set),
        original: values(u.original),
        defaults: [...(u.defaults ?? [])].sort((a, b) => a - b),
      });
  }
  for (const key of Object.values(e.deletes)) out.push({ kind: 'delete', key });
  for (const r of e.inserts) out.push({ kind: 'insert', values: values(r.values) });
  return out;
}
