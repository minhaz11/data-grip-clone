import clsx from 'clsx';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { askConfirm } from '../../app/dialogs';
import { ContextMenu, type MenuItem } from '../../components/ui/ContextMenu';
import { backend } from '../../ipc/client';
import type {
  Cell,
  ColumnInfo,
  EditTarget,
  ExportFormat,
  ExportOptions,
  GridLayout,
  Refinement,
  SessionKey,
  StatementOutcome,
  TableName,
} from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { aggregate } from './aggregates';
import {
  displayColumns,
  hideColumn,
  isDefault,
  moveColumn,
  NO_LAYOUT,
  showAllColumns,
} from './columnLayout';
import {
  addInsert,
  cloneRows,
  NO_EDITS,
  removeInsert,
  revertRows,
  rowKey,
  setCell,
  setDefault,
  setInsert,
  toggleDelete,
  unsetInsert,
  type PendingEdits,
} from './editsModel';
import { FilterBar } from './FilterBar';
import {
  initialWidth,
  PAGE_SIZE,
  pagesFor,
  ROW_HEIGHT,
  scrollTopFor,
  visibleWindow,
} from './gridModel';
import { GridToolbar, type OutputStatus } from './GridToolbar';
import { OutputDialog, type OutputChoice, type Scope } from './OutputDialog';
import { loadPages } from './pageLoader';
import { nextSort } from './refineModel';
import {
  clampSelection,
  colsIn,
  extend,
  inRange,
  rangeOf,
  rowsIn,
  selectAll,
  single,
  type CellRange,
  type GridSelection,
} from './selection';

type RowsOutcome = Extract<StatementOutcome, { type: 'rows' }>;

const NUMERIC = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money', 'oid']);
/** Columns whose text form aggregates as numbers (money has a currency format). */
const SUMMABLE = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'oid']);
const HEADER_HEIGHT = 26;
/** Pages kept in memory; older ones are dropped and refetched if scrolled back to. */
const MAX_CACHED_PAGES = 24;
/** Used until the viewport has been measured (and in environments without layout). */
const FALLBACK_VIEWPORT = 400;
/** Column widths per result view, so re-sorting or re-filtering keeps the user's layout. */
const widthCache = new Map<string, number[]>();
const NO_REFINEMENT: Refinement = { sort: [], filters: [] };
/** Whole-result copies above this many rows are confirmed first. */
export const COPY_CONFIRM_ROWS = 10_000;
/** Selections larger than this are copied with the whole-result copy (backend limit). */
export const MAX_SELECTION_ROWS = 100_000;
/** Cells summarized in the status bar at most (beyond that, aggregates are skipped). */
const MAX_AGGREGATE_CELLS = 50_000;

let idCounter = 0;
/** Unique ids for output jobs and new rows. */
function uniqueId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

interface Props {
  /** Session holding the result's cursor. */
  session: SessionKey;
  outcome: RowsOutcome;
  /** Base name suggested for exported files. */
  exportName: string;
  /** Present when the result can be re-run with server-side sort/filter. */
  onRefine?(refinement: Refinement): void;
  refinement?: Refinement;
  refining?: boolean;
  refineError?: string;
  /** Identifies the result view across re-runs (keeps column widths). */
  widthsKey?: string;
  /** Row editing; omit for read-only results. */
  editing?: EditingProps;
  /** Column order and visibility; changes go to `onLayoutChange` (`null`: back to default). */
  layout?: GridLayout;
  onLayoutChange?(layout: GridLayout | null): void;
  /** Table named by SQL INSERT copies; absent uses a placeholder. */
  sqlTable?: TableName;
  /** Rendered above the grid with edit actions for the current selection. */
  editBar?(actions: SelectionActions): ReactNode;
}

export interface EditingProps {
  target: EditTarget;
  edits: PendingEdits;
  /** While submitting, edits are frozen. */
  busy: boolean;
  onChange(f: (e: PendingEdits) => PendingEdits): void;
}

/** Edit actions over the selected rows and cells (shown in the edit bar). */
export interface SelectionActions {
  /** Selected rows (existing and new). */
  rows: number;
  clone(): void;
  revert(): void;
  setDefault(): void;
}

/**
 * Loads pages of a cursor-backed result on demand. Page 0 is the first page that came with the
 * outcome; results without a cursor only have that page.
 */
function usePages(session: SessionKey, outcome: RowsOutcome) {
  const [pages, setPages] = useState(() => new Map<number, Cell[][]>([[0, outcome.rows]]));
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(new Set<number>());
  const order = useRef<number[]>([0]);

  const ensure = useCallback(
    (wanted: number[]) => {
      if (!outcome.cursor) {
        return;
      }
      for (const page of wanted) {
        if (pages.has(page) || inFlight.current.has(page)) {
          continue;
        }
        inFlight.current.add(page);
        backend
          .resultPage(session, outcome.cursor, page * PAGE_SIZE, PAGE_SIZE)
          .then((rows) => {
            setPages((prev) => {
              const next = new Map(prev);
              next.set(page, rows);
              order.current = [...order.current.filter((p) => p !== page), page];
              // Evict least recently loaded pages (never page 0).
              while (order.current.length > MAX_CACHED_PAGES) {
                const old = order.current.find((p) => p !== 0 && !wanted.includes(p));
                if (old === undefined) {
                  break;
                }
                order.current = order.current.filter((p) => p !== old);
                next.delete(old);
              }
              return next;
            });
          })
          .catch((e: unknown) => setError(toAppError(e).message))
          .finally(() => inFlight.current.delete(page));
      }
    },
    [outcome.cursor, pages, session],
  );

  /** Pages for rows `[first, last]`, fetched (two at a time) when not cached. */
  const gather = useCallback(
    async (first: number, last: number) => {
      const wanted = pagesFor(first, last + 1);
      return loadPages(
        wanted,
        (p) => pages.get(p),
        (p) =>
          outcome.cursor
            ? backend.resultPage(session, outcome.cursor, p * PAGE_SIZE, PAGE_SIZE)
            : Promise.resolve([]),
      );
    },
    [outcome.cursor, pages, session],
  );

  const row = (index: number): Cell[] | undefined =>
    pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE];
  return { row, pages, ensure, gather, error };
}

export function ResultGrid({
  session,
  outcome,
  exportName,
  onRefine,
  refinement = NO_REFINEMENT,
  refining = false,
  refineError,
  widthsKey,
  editing,
  layout: controlledLayout,
  onLayoutChange,
  sqlTable,
  editBar,
}: Props) {
  const { columns } = outcome;
  // Rows the user can browse: all of them with a cursor, otherwise only what came back.
  const baseCount = outcome.cursor ? outcome.totalRows : outcome.rows.length;
  const { row, pages, ensure, gather, error } = usePages(session, outcome);
  const edits = editing?.edits ?? NO_EDITS;
  const target = editing?.target ?? null;
  // Inserted rows are shown after the existing ones.
  const rowCount = baseCount + edits.inserts.length;
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);

  // Column layout: controlled by the tab when it stores one, else local.
  const [localLayout, setLocalLayout] = useState<GridLayout>(NO_LAYOUT);
  const layout = controlledLayout ?? localLayout;
  const shown = useMemo(() => displayColumns(columns.length, layout), [columns.length, layout]);
  const hiddenCount = columns.length - shown.length;
  function changeLayout(next: GridLayout) {
    setLocalLayout(next);
    onLayoutChange?.(isDefault(next, columns.length) ? null : next);
  }

  function viewOf(r: number, loaded = row(r)): RowView {
    if (r >= baseCount) {
      const ins = edits.inserts[r - baseCount];
      const values = ins?.values ?? {};
      return {
        cells: columns.map((_, i) => (i in values ? (values[i] ?? null) : null)),
        state: 'inserted',
        changed: new Set(Object.keys(values).map(Number)),
        defaults: new Set(columns.map((_, i) => i).filter((i) => !(i in values))),
      };
    }
    const cells = loaded;
    const key = target ? rowKey(target, cells) : null;
    if (!key || !cells) {
      return { cells, state: 'normal', changed: new Set() };
    }
    if (key in edits.deletes) {
      return { cells, state: 'deleted', changed: new Set() };
    }
    const upd = edits.updates[key];
    if (!upd) {
      return { cells, state: 'normal', changed: new Set() };
    }
    const defaults = new Set(upd.defaults ?? []);
    return {
      cells: cells.map((v, i) => (i in upd.set ? (upd.set[i] ?? null) : v)),
      state: 'normal',
      changed: new Set([...Object.keys(upd.set).map(Number), ...defaults]),
      defaults,
    };
  }

  function canEdit(r: number, col: number): boolean {
    if (!editing || editing.busy || refining || !target?.columns[col]) {
      return false;
    }
    if (r >= baseCount) {
      return r - baseCount < edits.inserts.length;
    }
    const cells = row(r);
    const key = target ? rowKey(target, cells) : null;
    return key !== null && !(key in edits.deletes);
  }

  function commit(r: number, col: number, value: Cell) {
    if (!editing || !target) {
      return;
    }
    if (r >= baseCount) {
      const id = edits.inserts[r - baseCount]?.id;
      if (id) {
        editing.onChange((e) => setInsert(e, id, col, value));
      }
    } else {
      const original = row(r);
      if (original) {
        editing.onChange((e) => setCell(e, target, original, col, value));
      }
    }
  }

  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const [widths, setWidths] = useState(() => {
    const cached = widthsKey ? widthCache.get(widthsKey) : undefined;
    if (cached?.length === columns.length) {
      return cached;
    }
    return columns.map((c, i) =>
      initialWidth(
        c.name,
        outcome.rows.slice(0, 50).map((r) => r[i] ?? null),
      ),
    );
  });
  useEffect(() => {
    if (widthsKey) {
      widthCache.set(widthsKey, widths);
    }
  }, [widthsKey, widths]);

  const [selection, setSelection] = useState<GridSelection | null>(null);
  // A grid that lost rows or columns keeps the selection inside it.
  const sel = selection ? clampSelection(selection, rowCount, shown.length) : null;
  const range = sel ? rangeOf(sel) : null;
  const focus = sel?.focus ?? null;
  const dragging = useRef(false);

  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) {
      return;
    }
    const measure = () =>
      setViewport(
        Math.max(
          ROW_HEIGHT,
          (el.clientHeight || FALLBACK_VIEWPORT + HEADER_HEIGHT) - HEADER_HEIGHT,
        ),
      );
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const win = visibleWindow(rowCount, scroll.top, viewport);
  const needed = useMemo(() => pagesFor(win.first, win.last), [win.first, win.last]);
  useEffect(() => ensure(needed), [ensure, needed]);

  const numberWidth = Math.max(44, String(rowCount).length * 8 + 16);
  const totalWidth = numberWidth + shown.reduce((a, i) => a + (widths[i] ?? 100), 0);

  function startResize(col: number, e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const start = widths[col] ?? 100;
    const move = (ev: PointerEvent) =>
      setWidths((w) =>
        w.map((v, i) =>
          i === col ? Math.max(40, Math.min(1200, start + ev.clientX - startX)) : v,
        ),
      );
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function moveTo(r: number, c: number, extendSelection = false) {
    const rr = Math.max(0, Math.min(rowCount - 1, r));
    const cc = Math.max(0, Math.min(shown.length - 1, c));
    const pos = { row: rr, col: cc };
    setSelection(extendSelection && sel ? extend(sel, pos) : single(pos));
    const el = scroller.current;
    if (el) {
      el.scrollTop = scrollTopFor(rr, rowCount, viewport, el.scrollTop);
    }
  }

  // ----- Copy and export -----

  const [status, setStatus] = useState<OutputStatus>(null);
  const [dialog, setDialog] = useState<'copy' | 'export' | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; label: string }>();

  /** Rows `[top, bottom]` as shown (pending edits applied), fetching unloaded pages. */
  async function shownRows(top: number, bottom: number): Promise<Cell[][]> {
    const lastBase = Math.min(bottom, baseCount - 1);
    const pages = top <= lastBase ? await gather(top, lastBase) : new Map<number, Cell[][]>();
    const out: Cell[][] = [];
    for (let r = top; r <= bottom; r++) {
      const loaded =
        r < baseCount ? pages.get(Math.floor(r / PAGE_SIZE))?.[r % PAGE_SIZE] : undefined;
      const view = viewOf(r, loaded);
      out.push(columns.map((_, i) => (view.defaults?.has(i) ? null : (view.cells?.[i] ?? null))));
    }
    return out;
  }

  async function copyRange(cellRange: CellRange, format: ExportFormat, options: ExportOptions) {
    if (rowsIn(cellRange) > MAX_SELECTION_ROWS) {
      setStatus({
        kind: 'error',
        text: `Selections of more than ${MAX_SELECTION_ROWS.toLocaleString()} rows are copied as the entire result.`,
      });
      return;
    }
    try {
      const picked = shown.slice(cellRange.left, cellRange.right + 1);
      const rows = (await shownRows(cellRange.top, cellRange.bottom)).map((cells) =>
        picked.map((i) => cells[i] ?? null),
      );
      const text = await backend.resultFormat(
        picked.map((i) => columns[i] as ColumnInfo),
        rows,
        format,
        options,
      );
      await navigator.clipboard?.writeText(text);
      setStatus({
        kind: 'done',
        text: `Copied ${rows.length.toLocaleString()} ${rows.length === 1 ? 'row' : 'rows'}`,
      });
    } catch (e) {
      setStatus({ kind: 'error', text: `Copy failed: ${toAppError(e).message}` });
    }
  }

  async function copyCells() {
    if (!range) {
      return;
    }
    if (rowsIn(range) === 1 && colsIn(range) === 1) {
      // One cell: its value as is.
      const view = viewOf(range.top);
      const value = view.cells?.[shown[range.left] ?? 0];
      if (value !== undefined) {
        await navigator.clipboard?.writeText(value ?? '');
      }
      return;
    }
    // Several cells paste into spreadsheets as tab-separated rows without a header.
    await copyRange(range, 'tsv', { nullText: null, quoteAll: false, header: false });
  }

  async function wholeResult(choice: OutputChoice) {
    const cursor = outcome.cursor;
    if (!cursor) {
      // Results without a cursor are all in memory.
      await copyRange(
        { top: 0, bottom: rowCount - 1, left: 0, right: shown.length - 1 },
        choice.format,
        choice.options,
      );
      return;
    }
    const job = uniqueId('out');
    const toFile = choice.target === 'file';
    if (!toFile && outcome.totalRows > COPY_CONFIRM_ROWS) {
      const ok = await askConfirm({
        title: `Copy ${outcome.totalRows.toLocaleString()} rows?`,
        confirmLabel: 'Copy',
        body: (
          <p>
            The whole result goes to the clipboard as text. For large results, exporting to a file
            is usually better.
          </p>
        ),
      });
      if (!ok) {
        return;
      }
    }
    const label = toFile ? `Exporting ${choice.format.toUpperCase()}` : 'Copying';
    setStatus({ kind: 'running', job, label, rows: 0 });
    // Progress can arrive after the command resolved; it only updates this job while running.
    const progress = (rows: number) =>
      setStatus((s) => (s?.kind === 'running' && s.job === job ? { ...s, rows } : s));
    try {
      if (toFile) {
        const summary = await backend.resultExport(
          session,
          cursor,
          columns,
          choice.format,
          choice.options,
          exportName,
          job,
          progress,
        );
        setStatus(
          summary
            ? {
                kind: 'done',
                text: `Exported ${summary.rows.toLocaleString()} rows to ${summary.path.split(/[\\/]/).pop()}`,
                title: summary.path,
              }
            : { kind: 'done', text: 'Export cancelled' },
        );
      } else {
        const summary = await backend.resultCopy(
          session,
          cursor,
          columns,
          choice.format,
          choice.options,
          job,
          progress,
        );
        setStatus(
          summary
            ? { kind: 'done', text: `Copied ${summary.rows.toLocaleString()} rows` }
            : { kind: 'done', text: 'Copy cancelled' },
        );
      }
    } catch (e) {
      setStatus({
        kind: 'error',
        text: `${toFile ? 'Export' : 'Copy'} failed: ${toAppError(e).message}`,
      });
    }
  }

  const pageOf = Math.floor((focus?.row ?? 0) / PAGE_SIZE);
  const pageRange: CellRange = {
    top: pageOf * PAGE_SIZE,
    bottom: Math.min(rowCount, (pageOf + 1) * PAGE_SIZE) - 1,
    left: 0,
    right: shown.length - 1,
  };
  const scopes: Scope[] = [
    {
      id: 'selection',
      label: range
        ? `Selection (${rowsIn(range).toLocaleString()} × ${colsIn(range)} cells)`
        : 'Selection (nothing selected)',
      disabled: !range,
    },
    {
      id: 'page',
      label: `Page (rows ${(pageRange.top + 1).toLocaleString()}–${(pageRange.bottom + 1).toLocaleString()})`,
      disabled: rowCount === 0,
    },
    {
      id: 'all',
      label: `Entire result (${outcome.totalRows.toLocaleString()} rows, all columns as stored)`,
    },
  ];

  function onOutput(choice: OutputChoice) {
    setDialog(null);
    if (choice.scope === 'selection' && range) {
      void copyRange(range, choice.format, choice.options);
    } else if (choice.scope === 'page') {
      void copyRange(pageRange, choice.format, choice.options);
    } else {
      void wholeResult(choice);
    }
  }

  // ----- Columns -----

  function columnItems(display: number): MenuItem[] {
    const column = shown[display];
    const items: MenuItem[] = [];
    if (display > 0) {
      items.push({
        label: 'Move left',
        onSelect: () => changeLayout(moveColumn(columns.length, layout, display, display - 1)),
      });
    }
    if (display < shown.length - 1) {
      items.push({
        label: 'Move right',
        onSelect: () => changeLayout(moveColumn(columns.length, layout, display, display + 1)),
      });
    }
    if (column !== undefined && shown.length > 1) {
      items.push({
        label: `Hide ${columns[column]?.name ?? 'column'}`,
        onSelect: () => changeLayout(hideColumn(columns.length, layout, column)),
      });
    }
    return [...items, ...layoutItems()];
  }

  function layoutItems(): MenuItem[] {
    const items: MenuItem[] = [];
    if (hiddenCount > 0) {
      items.push({
        label: 'Show all columns',
        onSelect: () => changeLayout(showAllColumns(layout)),
      });
    }
    if (!isDefault(layout, columns.length)) {
      items.push({ label: 'Reset column layout', onSelect: () => changeLayout(NO_LAYOUT) });
    }
    return items;
  }

  function openColumnsMenu(anchor: HTMLElement) {
    const box = anchor.getBoundingClientRect();
    const hidden = new Set(columns.map((_, i) => i).filter((i) => !shown.includes(i)));
    setMenu({
      x: box.left,
      y: box.bottom,
      label: 'Columns',
      items: [
        ...columns.map((c, i) => ({
          label: `${hidden.has(i) ? 'Show' : 'Hide'} ${c.name}`,
          onSelect: () =>
            changeLayout(
              hidden.has(i)
                ? { order: layout.order, hidden: layout.hidden.filter((h) => h !== i) }
                : hideColumn(columns.length, layout, i),
            ),
        })),
        ...layoutItems(),
      ],
    });
  }

  const dragColumn = useRef<number | null>(null);

  // ----- Edit actions over the selection -----

  function selectedRows(): { existing: Cell[][]; insertIds: string[] } {
    const existing: Cell[][] = [];
    const insertIds: string[] = [];
    if (!range) {
      return { existing, insertIds };
    }
    for (let r = range.top; r <= range.bottom; r++) {
      if (r >= baseCount) {
        const id = edits.inserts[r - baseCount]?.id;
        if (id) {
          insertIds.push(id);
        }
      } else {
        const cells = row(r);
        if (cells) {
          existing.push(cells);
        }
      }
    }
    return { existing, insertIds };
  }

  const actions: SelectionActions = {
    rows: range ? rowsIn(range) : 0,
    clone() {
      if (!editing || !target || editing.busy) {
        return;
      }
      const { existing, insertIds } = selectedRows();
      const fromInserts = edits.inserts
        .filter((r) => insertIds.includes(r.id))
        .map((r) => columns.map((_, i) => (i in r.values ? (r.values[i] ?? null) : null)));
      const stamp = uniqueId('new');
      editing.onChange((e) =>
        cloneRows(e, target, [...existing, ...fromInserts], (n) => `${stamp}-${n}`),
      );
    },
    revert() {
      if (!editing || !target || editing.busy) {
        return;
      }
      const { existing, insertIds } = selectedRows();
      editing.onChange((e) => revertRows(e, target, existing, insertIds));
    },
    setDefault() {
      if (!editing || !target || editing.busy || !range) {
        return;
      }
      const cols = shown.slice(range.left, range.right + 1);
      editing.onChange((e) => {
        let next = e;
        for (let r = range.top; r <= range.bottom; r++) {
          if (r >= baseCount) {
            const id = e.inserts[r - baseCount]?.id;
            for (const c of cols) {
              if (id) {
                next = unsetInsert(next, id, c);
              }
            }
          } else {
            const cells = row(r);
            const key = cells ? rowKey(target, cells) : null;
            if (cells && key !== null && !(key in e.deletes)) {
              for (const c of cols) {
                next = setDefault(next, target, cells, c);
              }
            }
          }
        }
        return next;
      });
    },
  };

  // ----- Keyboard -----

  function onKeyDown(e: React.KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (!focus || rowCount === 0) {
      if (editing && e.key === 'Insert' && !editing.busy) {
        e.preventDefault();
        editing.onChange((x) => addInsert(x, `new-${Date.now()}-${x.inserts.length}`));
        setSelection(single({ row: 0, col: 0 }));
      }
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelection(selectAll(rowCount, shown.length));
      return;
    }
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      void copyCells();
      return;
    }
    const page = Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1);
    const keys: Record<string, () => void> = {
      ArrowDown: () => moveTo(focus.row + 1, focus.col, e.shiftKey),
      ArrowUp: () => moveTo(focus.row - 1, focus.col, e.shiftKey),
      ArrowRight: () => moveTo(focus.row, focus.col + 1, e.shiftKey),
      ArrowLeft: () => moveTo(focus.row, focus.col - 1, e.shiftKey),
      PageDown: () => moveTo(focus.row + page, focus.col, e.shiftKey),
      PageUp: () => moveTo(focus.row - page, focus.col, e.shiftKey),
      Home: () => moveTo(mod ? 0 : focus.row, 0, e.shiftKey),
      End: () => moveTo(mod ? rowCount - 1 : focus.row, shown.length - 1, e.shiftKey),
    };
    const focusColumn = shown[focus.col] ?? 0;
    if (editing && !editingCell) {
      if ((e.key === 'Enter' || e.key === 'F2') && canEdit(focus.row, focusColumn)) {
        e.preventDefault();
        setEditingCell({ row: focus.row, col: focusColumn });
        return;
      }
      if (e.key === 'Delete' && target && !editing.busy && range) {
        e.preventDefault();
        // Every selected row: new rows are removed, existing ones marked (or unmarked).
        const { existing, insertIds } = selectedRows();
        editing.onChange((x) => {
          let next = x;
          for (const id of insertIds) {
            next = removeInsert(next, id);
          }
          for (const cells of existing) {
            next = toggleDelete(next, target, cells);
          }
          return next;
        });
        return;
      }
      if (e.key === 'Insert' && !editing.busy) {
        e.preventDefault();
        editing.onChange((x) => addInsert(x, `new-${Date.now()}-${x.inserts.length}`));
        // The new row is at the old row count (moveTo would clamp to the old last row).
        setSelection(single({ row: rowCount, col: 0 }));
        return;
      }
    }
    const action = keys[e.key];
    if (action) {
      e.preventDefault();
      action();
    }
  }

  // ----- Aggregates -----

  const summary = useMemo(() => {
    if (!range || rowsIn(range) * colsIn(range) < 2) {
      return null;
    }
    if (rowsIn(range) * colsIn(range) > MAX_AGGREGATE_CELLS) {
      return { text: 'Too many cells to summarize', partial: false };
    }
    let count = 0;
    let unloaded = false;
    const numbers: string[] = [];
    for (let r = range.top; r <= range.bottom; r++) {
      const view = viewOf(r);
      if (!view.cells) {
        unloaded = true;
        continue;
      }
      for (let d: number = range.left; d <= range.right; d++) {
        const i = shown[d] ?? 0;
        const v = view.defaults?.has(i) ? null : view.cells[i];
        if (v === null || v === undefined) {
          continue;
        }
        count += 1;
        const type = columns[i]?.typeName;
        if (type && SUMMABLE.has(type)) {
          numbers.push(v);
        }
      }
    }
    const a = aggregate(numbers, count);
    const parts = [`Count ${count.toLocaleString()}`];
    if (a) {
      const approx = a.approximate ? '≈' : '';
      parts.push(`Sum ${approx}${a.sum}`, `Avg ${approx}${a.avg}`, `Min ${a.min}`, `Max ${a.max}`);
    }
    return { text: parts.join(' · '), partial: unloaded };
    // `viewOf` reads rows and edits, which change with these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.top, range?.bottom, range?.left, range?.right, pages, edits, shown, columns]);

  const rows: number[] = [];
  for (let i = win.first; i < win.last; i++) {
    rows.push(i);
  }

  return (
    <div className="flex h-full flex-col">
      {editBar?.(actions)}
      <GridToolbar
        outcome={outcome}
        rowCount={rowCount}
        error={refineError ?? error}
        refining={refining}
        refinement={refinement}
        status={status}
        hiddenColumns={hiddenCount}
        onCopy={() => setDialog('copy')}
        onExport={() => setDialog('export')}
        onColumns={openColumnsMenu}
        onCancel={(job) => void backend.resultExportCancel(job)}
      />
      {onRefine && (
        <FilterBar
          columns={columns}
          filters={refinement.filters}
          busy={refining}
          onChange={(filters) => onRefine({ ...refinement, filters })}
        />
      )}
      <div
        ref={scroller}
        role="grid"
        aria-label="Result rows"
        aria-rowcount={rowCount + 1}
        aria-colcount={shown.length}
        aria-multiselectable
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => !selection && rowCount > 0 && setSelection(single({ row: 0, col: 0 }))}
        onScroll={(e) =>
          setScroll({ top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft })
        }
        className="relative min-h-0 flex-1 overflow-auto font-mono text-[12px] outline-none select-none"
      >
        {/* Spacer sized to the (possibly scaled) full result; the window below stays in view. */}
        <div style={{ height: HEADER_HEIGHT + win.scrollHeight, width: totalWidth }}>
          <div
            className="sticky top-0"
            style={{
              height: HEADER_HEIGHT + viewport,
              marginBottom: -(HEADER_HEIGHT + viewport),
              width: totalWidth,
            }}
          >
            <div
              role="row"
              aria-rowindex={1}
              className="flex border-b border-border bg-panel"
              style={{ height: HEADER_HEIGHT }}
            >
              <div
                className="shrink-0 border-r border-border"
                style={{ width: numberWidth }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (rowCount > 0) {
                    setSelection(selectAll(rowCount, shown.length));
                  }
                }}
                title="Select all"
              />
              {shown.map((i, d) => {
                const c = columns[i] as ColumnInfo;
                return (
                  <div
                    key={i}
                    role="columnheader"
                    aria-colindex={d + 1}
                    aria-sort={sortState(refinement, i)}
                    draggable
                    onDragStart={(e) => {
                      dragColumn.current = d;
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragOver={(e) => {
                      if (dragColumn.current !== null) {
                        e.preventDefault();
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = dragColumn.current;
                      dragColumn.current = null;
                      if (from !== null && from !== d) {
                        changeLayout(moveColumn(columns.length, layout, from, d));
                      }
                    }}
                    onDragEnd={() => {
                      dragColumn.current = null;
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenu({
                        x: e.clientX,
                        y: e.clientY,
                        label: `Column ${c.name}`,
                        items: columnItems(d),
                      });
                    }}
                    title={
                      (c.typeName ? `${c.name} (${c.typeName})` : c.name) +
                      (onRefine ? '\nClick to sort, Shift+click to add a sort column' : '') +
                      '\nDrag to reorder; right-click to hide or move'
                    }
                    className="relative flex shrink-0 items-center gap-1.5 overflow-hidden border-r border-border px-2 font-semibold whitespace-nowrap"
                    style={{ width: widths[i] }}
                  >
                    {onRefine ? (
                      <button
                        type="button"
                        disabled={refining}
                        onClick={(e) =>
                          onRefine({
                            ...refinement,
                            sort: nextSort(refinement.sort, i, e.shiftKey),
                          })
                        }
                        onKeyDown={(e) => {
                          // The column menu from the keyboard.
                          if (e.key === 'F10' && e.shiftKey) {
                            e.preventDefault();
                            const box = e.currentTarget.getBoundingClientRect();
                            setMenu({
                              x: box.left,
                              y: box.bottom,
                              label: `Column ${c.name}`,
                              items: columnItems(d),
                            });
                          }
                        }}
                        className="min-w-0 truncate text-left font-semibold hover:text-accent disabled:cursor-wait"
                      >
                        {c.name}
                      </button>
                    ) : (
                      <span className="truncate">{c.name}</span>
                    )}
                    <SortIndicator refinement={refinement} column={i} />
                    {c.typeName && (
                      <span className="truncate font-normal text-muted">{c.typeName}</span>
                    )}
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${c.name}`}
                      onPointerDown={(e) => startResize(i, e)}
                      onDoubleClick={() =>
                        setWidths((w) =>
                          w.map((v, j) =>
                            j === i
                              ? initialWidth(
                                  c.name,
                                  outcome.rows.map((r) => r[i] ?? null),
                                )
                              : v,
                          ),
                        )
                      }
                      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-accent"
                    />
                  </div>
                );
              })}
            </div>
            <div className="relative overflow-hidden" style={{ height: viewport }}>
              {rows.map((r) => (
                <GridRow
                  key={r}
                  index={r}
                  top={win.shift + (r - win.first) * ROW_HEIGHT}
                  view={viewOf(r)}
                  columns={columns}
                  shown={shown}
                  widths={widths}
                  numberWidth={numberWidth}
                  range={range}
                  focusCol={focus?.row === r ? focus.col : null}
                  onPointerSelect={(d, shift) => {
                    dragging.current = true;
                    const pos = { row: r, col: d };
                    setSelection(shift && sel ? extend(sel, pos) : single(pos));
                  }}
                  onSelectRow={(shift) => {
                    dragging.current = true;
                    const anchorRow = shift && sel ? sel.anchor.row : r;
                    setSelection({
                      anchor: { row: anchorRow, col: 0 },
                      focus: { row: r, col: shown.length - 1 },
                    });
                  }}
                  onPointerExtend={(d) => {
                    if (dragging.current && sel) {
                      setSelection(extend(sel, { row: r, col: d }));
                    }
                  }}
                  onEdit={(col) => canEdit(r, col) && setEditingCell({ row: r, col })}
                  editor={
                    editingCell?.row === r
                      ? {
                          col: editingCell.col,
                          node: (
                            <CellEditor
                              initial={viewOf(r).cells?.[editingCell.col] ?? ''}
                              onCancel={() => {
                                setEditingCell(null);
                                scroller.current?.focus();
                              }}
                              onCommit={(value, move) => {
                                const { row: er, col: ec } = editingCell;
                                setEditingCell(null);
                                commit(er, ec, value);
                                scroller.current?.focus();
                                const display: number = shown.indexOf(ec);
                                if (move === 'down') {
                                  moveTo(er + 1, display);
                                }
                                if (move === 'right') {
                                  moveTo(er, display + 1);
                                }
                              }}
                            />
                          ),
                        }
                      : null
                  }
                />
              ))}
            </div>
          </div>
        </div>
      </div>
      {rowCount === 0 && <p className="px-3 py-2 text-muted">No rows.</p>}
      {summary && (
        <div
          role="status"
          aria-label="Selection summary"
          className="flex h-6 shrink-0 items-center gap-2 border-t border-border bg-panel px-2 text-[12px] text-muted tabular-nums"
        >
          {range && (
            <span>
              {rowsIn(range).toLocaleString()} × {colsIn(range)}
            </span>
          )}
          <span className="truncate">{summary.text}</span>
          {summary.partial && <span>(loaded rows only)</span>}
        </div>
      )}
      {dialog && (
        <OutputDialog
          mode={dialog}
          scopes={scopes}
          initialScope={range && rowsIn(range) * colsIn(range) > 1 ? 'selection' : 'all'}
          table={sqlTable}
          rows={outcome.totalRows}
          onSubmit={onOutput}
          onClose={() => setDialog(null)}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.label}
          items={menu.items}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}

/** How one visible row should look, derived from loaded cells plus pending edits. */
interface RowView {
  cells: Cell[] | undefined;
  state: 'normal' | 'deleted' | 'inserted';
  /** Columns with a pending value (shown highlighted). */
  changed: Set<number>;
  /** Columns left to (or set to) the server default. */
  defaults?: Set<number>;
}

function GridRow({
  index,
  top,
  view,
  columns,
  shown,
  widths,
  numberWidth,
  range,
  focusCol,
  editor,
  onPointerSelect,
  onPointerExtend,
  onSelectRow,
  onEdit,
}: {
  index: number;
  top: number;
  view: RowView;
  columns: ColumnInfo[];
  /** Result-column index per display position. */
  shown: number[];
  widths: number[];
  numberWidth: number;
  range: CellRange | null;
  /** Display position of the active cell when it is in this row. */
  focusCol: number | null;
  editor: { col: number; node: React.ReactNode } | null;
  onPointerSelect(display: number, shift: boolean): void;
  onPointerExtend(display: number): void;
  onSelectRow(shift: boolean): void;
  onEdit(col: number): void;
}) {
  const { cells, state } = view;
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      data-state={state}
      className={clsx(
        'absolute left-0 flex hover:bg-hover',
        state === 'deleted' && 'bg-danger/10 text-muted line-through',
        state === 'inserted' && 'bg-[#3f9d5a]/10',
      )}
      style={{ top, height: ROW_HEIGHT }}
    >
      <div
        className="shrink-0 border-r border-b border-border px-2 text-right leading-[22px] text-muted tabular-nums no-underline"
        style={{ width: numberWidth }}
        onMouseDown={(e) => {
          // The row number selects the whole row.
          e.preventDefault();
          onSelectRow(e.shiftKey);
        }}
      >
        {state === 'inserted' ? '+' : index + 1}
      </div>
      {shown.map((i, d) => {
        const c = columns[i] as ColumnInfo;
        const v = cells?.[i];
        const numeric = c.typeName !== undefined && NUMERIC.has(c.typeName ?? '');
        const changed = view.changed.has(i);
        const selected = range !== null && inRange(range, index, d);
        const active = focusCol === d;
        return (
          <div
            key={i}
            role="gridcell"
            aria-colindex={d + 1}
            aria-selected={selected}
            data-active={active || undefined}
            data-changed={changed || undefined}
            onMouseDown={(e) => {
              if (e.button === 0) {
                onPointerSelect(d, e.shiftKey);
              }
            }}
            onMouseEnter={() => onPointerExtend(d)}
            onDoubleClick={() => onEdit(i)}
            title={v === undefined ? undefined : (v ?? 'NULL')}
            className={clsx(
              'relative shrink-0 truncate border-r border-b border-border px-2 leading-[22px] whitespace-pre',
              numeric && 'text-right tabular-nums',
              changed && 'bg-[#d98a1f]/25',
              selected && 'bg-selected',
              active && 'outline outline-1 -outline-offset-1 outline-accent',
            )}
            style={{ width: widths[i] }}
          >
            {editor?.col === i ? (
              editor.node
            ) : view.defaults?.has(i) ? (
              <span className="text-muted italic">default</span>
            ) : cells === undefined ? (
              <span className="text-muted">…</span>
            ) : v === null ? (
              <span className="text-muted italic">NULL</span>
            ) : (
              v
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Inline cell editor: Enter saves and moves down, Tab saves and moves right, Esc cancels. */
function CellEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit(value: Cell, move: 'down' | 'right' | 'none'): void;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState(initial);
  // Finish exactly once: some engines fire blur when the editor is removed after Enter/Esc.
  const done = useRef(false);
  const finish = (f: () => void) => {
    if (done.current) {
      return;
    }
    done.current = true;
    f();
  };
  return (
    <div className="absolute inset-0 z-10 flex bg-bg" onMouseDown={(e) => e.stopPropagation()}>
      <input
        aria-label="Cell value"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(() => onCommit(draft, 'down'));
          } else if (e.key === 'Tab') {
            e.preventDefault();
            finish(() => onCommit(draft, 'right'));
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(onCancel);
          }
        }}
        onBlur={() => finish(() => onCommit(draft, 'none'))}
        className="min-w-0 flex-1 bg-transparent px-1.5 font-mono outline outline-2 -outline-offset-2 outline-accent select-text"
      />
      <button
        type="button"
        aria-label="Set NULL"
        title="Set NULL"
        onMouseDown={(e) => {
          e.preventDefault(); // keep focus so blur does not save the draft first
          finish(() => onCommit(null, 'none'));
        }}
        className="shrink-0 px-1 text-[10px] text-muted hover:text-fg"
      >
        NULL
      </button>
    </div>
  );
}

function sortState(r: Refinement, column: number): 'ascending' | 'descending' | 'none' {
  const k = r.sort.find((x) => x.column === column);
  return k ? (k.descending ? 'descending' : 'ascending') : 'none';
}

function SortIndicator({ refinement, column }: { refinement: Refinement; column: number }) {
  const at = refinement.sort.findIndex((k) => k.column === column);
  const key = refinement.sort[at];
  if (!key) {
    return null;
  }
  const Icon = key.descending ? ArrowDown : ArrowUp;
  return (
    <span className="flex shrink-0 items-center text-accent" aria-hidden>
      <Icon size={11} />
      {refinement.sort.length > 1 && <span className="text-[10px]">{at + 1}</span>}
    </span>
  );
}
