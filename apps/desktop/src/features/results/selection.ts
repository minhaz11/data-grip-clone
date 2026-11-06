/**
 * Rectangular cell selection over the grid (M4.8). Columns are display positions (after hiding and
 * reordering), so a range always covers adjacent columns on screen.
 */

export interface CellPos {
  row: number;
  /** Display position of the column. */
  col: number;
}

export interface GridSelection {
  /** Where the selection started (stays put while Shift extends it). */
  anchor: CellPos;
  /** The active cell; Shift+arrows and Shift+click move it. */
  focus: CellPos;
}

/** Inclusive bounds of a selection. */
export interface CellRange {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function single(pos: CellPos): GridSelection {
  return { anchor: pos, focus: pos };
}

export function extend(sel: GridSelection, focus: CellPos): GridSelection {
  return { anchor: sel.anchor, focus };
}

export function rangeOf(sel: GridSelection): CellRange {
  return {
    top: Math.min(sel.anchor.row, sel.focus.row),
    bottom: Math.max(sel.anchor.row, sel.focus.row),
    left: Math.min(sel.anchor.col, sel.focus.col),
    right: Math.max(sel.anchor.col, sel.focus.col),
  };
}

export function inRange(range: CellRange, row: number, col: number): boolean {
  return row >= range.top && row <= range.bottom && col >= range.left && col <= range.right;
}

export function rowsIn(range: CellRange): number {
  return range.bottom - range.top + 1;
}

export function colsIn(range: CellRange): number {
  return range.right - range.left + 1;
}

/** Every cell of a grid with `rows` rows and `cols` columns. */
export function selectAll(rows: number, cols: number): GridSelection {
  return { anchor: { row: 0, col: 0 }, focus: { row: rows - 1, col: cols - 1 } };
}

/** Keeps a selection inside a grid that shrank (fewer rows or visible columns). */
export function clampSelection(
  sel: GridSelection,
  rows: number,
  cols: number,
): GridSelection | null {
  if (rows === 0 || cols === 0) {
    return null;
  }
  const clamp = (p: CellPos) => ({
    row: Math.max(0, Math.min(rows - 1, p.row)),
    col: Math.max(0, Math.min(cols - 1, p.col)),
  });
  return { anchor: clamp(sel.anchor), focus: clamp(sel.focus) };
}
