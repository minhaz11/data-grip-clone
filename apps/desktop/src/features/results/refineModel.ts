import type { FilterOp, SortKey } from '../../ipc/types';

/**
 * Header click: plain click makes `column` the only sort key, cycling asc → desc → off.
 * Shift+click adds it as a further key, or cycles it in place (asc → desc → removed).
 */
export function nextSort(sort: SortKey[], column: number, additive: boolean): SortKey[] {
  const existing = sort.find((k) => k.column === column);
  if (!additive) {
    if (existing && sort.length === 1)
      return existing.descending ? [] : [{ column, descending: true }];
    return [{ column, descending: false }];
  }
  if (!existing) return [...sort, { column, descending: false }];
  if (!existing.descending)
    return sort.map((k) => (k.column === column ? { column, descending: true } : k));
  return sort.filter((k) => k.column !== column);
}

export const FILTER_OPS: { op: FilterOp; label: string; needsValue: boolean }[] = [
  { op: 'eq', label: '=', needsValue: true },
  { op: 'ne', label: '≠', needsValue: true },
  { op: 'lt', label: '<', needsValue: true },
  { op: 'le', label: '≤', needsValue: true },
  { op: 'gt', label: '>', needsValue: true },
  { op: 'ge', label: '≥', needsValue: true },
  { op: 'contains', label: 'contains', needsValue: true },
  { op: 'starts_with', label: 'starts with', needsValue: true },
  { op: 'is_null', label: 'is NULL', needsValue: false },
  { op: 'not_null', label: 'is not NULL', needsValue: false },
];

export const opLabel = (op: FilterOp) => FILTER_OPS.find((o) => o.op === op)?.label ?? op;
export const needsValue = (op: FilterOp) => FILTER_OPS.find((o) => o.op === op)?.needsValue ?? true;
