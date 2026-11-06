import type { ColumnInfo, GridLayout } from '../../ipc/types';

/**
 * Column order and visibility of a result (M4.8). A layout is stored per tab under the result's
 * column signature, so it comes back when the same query runs again or the app restarts, and a
 * different column list starts fresh.
 */

export const NO_LAYOUT: GridLayout = { order: [], hidden: [] };

/** Identifies a column list: names and types in order. */
export function signature(columns: ColumnInfo[]): string {
  return columns.map((c) => `${c.name}:${c.typeName ?? ''}`).join('\u001f');
}

/** Result-column indices in display order, hidden ones left out. */
export function displayColumns(count: number, layout: GridLayout = NO_LAYOUT): number[] {
  const valid = layout.order.filter(
    (i, at) => i >= 0 && i < count && layout.order.indexOf(i) === at,
  );
  const rest = Array.from({ length: count }, (_, i) => i).filter((i) => !valid.includes(i));
  const hidden = new Set(layout.hidden);
  const shown = [...valid, ...rest].filter((i) => !hidden.has(i));
  // Never hide everything.
  return shown.length > 0 ? shown : Array.from({ length: count }, (_, i) => i);
}

/** Moves the column at display position `from` to display position `to`. */
export function moveColumn(
  count: number,
  layout: GridLayout,
  from: number,
  to: number,
): GridLayout {
  const shown = displayColumns(count, layout);
  const column = shown[from];
  if (column === undefined || from === to) {
    return layout;
  }
  const next = shown.filter((_, i) => i !== from);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, column);
  // Hidden columns keep their place after the shown ones.
  const hidden = layout.hidden.filter((i) => i < count);
  return { order: [...next, ...hidden], hidden };
}

export function hideColumn(count: number, layout: GridLayout, column: number): GridLayout {
  const shown = displayColumns(count, layout);
  if (shown.length <= 1 || !shown.includes(column)) {
    return layout;
  }
  return { order: layout.order, hidden: [...layout.hidden, column] };
}

export function showAllColumns(layout: GridLayout): GridLayout {
  return { order: layout.order, hidden: [] };
}

export function isDefault(layout: GridLayout | undefined, count: number): boolean {
  if (!layout) {
    return true;
  }
  return layout.hidden.length === 0 && displayColumns(count, layout).every((c, i) => c === i);
}
