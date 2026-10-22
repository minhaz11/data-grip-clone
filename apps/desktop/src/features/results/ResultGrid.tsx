import clsx from 'clsx';
import { ArrowDown, ArrowUp, Download, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { backend } from '../../ipc/client';
import type {
  Cell,
  ColumnInfo,
  ExportFormat,
  EditTarget,
  ExportSummary,
  Refinement,
  SessionKey,
  StatementOutcome,
} from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import {
  initialWidth,
  PAGE_SIZE,
  pagesFor,
  ROW_HEIGHT,
  scrollTopFor,
  visibleWindow,
} from './gridModel';
import { FilterBar } from './FilterBar';
import { nextSort } from './refineModel';
import {
  addInsert,
  NO_EDITS,
  removeInsert,
  rowKey,
  setCell,
  setInsert,
  toggleDelete,
  type PendingEdits,
} from './editsModel';

type RowsOutcome = Extract<StatementOutcome, { type: 'rows' }>;

const NUMERIC = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money', 'oid']);
const HEADER_HEIGHT = 26;
/** Pages kept in memory; older ones are dropped and refetched if scrolled back to. */
const MAX_CACHED_PAGES = 24;
/** Used until the viewport has been measured (and in environments without layout). */
const FALLBACK_VIEWPORT = 400;
/** Column widths per result view, so re-sorting or re-filtering keeps the user's layout. */
const widthCache = new Map<string, number[]>();
const NO_REFINEMENT: Refinement = { sort: [], filters: [] };

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
}

export interface EditingProps {
  target: EditTarget;
  edits: PendingEdits;
  /** While submitting, edits are frozen. */
  busy: boolean;
  onChange(f: (e: PendingEdits) => PendingEdits): void;
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
      if (!outcome.cursor) return;
      for (const page of wanted) {
        if (pages.has(page) || inFlight.current.has(page)) continue;
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
                if (old === undefined) break;
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

  const row = (index: number): Cell[] | undefined =>
    pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE];
  return { row, ensure, error };
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
}: Props) {
  const { columns } = outcome;
  // Rows the user can browse: all of them with a cursor, otherwise only what came back.
  const baseCount = outcome.cursor ? outcome.totalRows : outcome.rows.length;
  const { row, ensure, error } = usePages(session, outcome);
  const edits = editing?.edits ?? NO_EDITS;
  const target = editing?.target ?? null;
  // Inserted rows are shown after the existing ones.
  const rowCount = baseCount + edits.inserts.length;
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);

  function viewOf(r: number): RowView {
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
    const cells = row(r);
    const key = target ? rowKey(target, cells) : null;
    if (!key || !cells) return { cells, state: 'normal', changed: new Set() };
    if (key in edits.deletes) return { cells, state: 'deleted', changed: new Set() };
    const upd = edits.updates[key];
    if (!upd) return { cells, state: 'normal', changed: new Set() };
    return {
      cells: cells.map((v, i) => (i in upd.set ? (upd.set[i] ?? null) : v)),
      state: 'normal',
      changed: new Set(Object.keys(upd.set).map(Number)),
    };
  }

  function canEdit(r: number, col: number): boolean {
    if (!editing || editing.busy || refining || !target?.columns[col]) return false;
    if (r >= baseCount) return r - baseCount < edits.inserts.length;
    const cells = row(r);
    const key = target ? rowKey(target, cells) : null;
    return key !== null && !(key in edits.deletes);
  }

  function commit(r: number, col: number, value: Cell) {
    if (!editing || !target) return;
    if (r >= baseCount) {
      const id = edits.inserts[r - baseCount]?.id;
      if (id) editing.onChange((e) => setInsert(e, id, col, value));
    } else {
      const original = row(r);
      if (original) editing.onChange((e) => setCell(e, target, original, col, value));
    }
  }

  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const [viewport, setViewport] = useState(FALLBACK_VIEWPORT);
  const [widths, setWidths] = useState(() => {
    const cached = widthsKey ? widthCache.get(widthsKey) : undefined;
    if (cached?.length === columns.length) return cached;
    return columns.map((c, i) =>
      initialWidth(
        c.name,
        outcome.rows.slice(0, 50).map((r) => r[i] ?? null),
      ),
    );
  });
  useEffect(() => {
    if (widthsKey) widthCache.set(widthsKey, widths);
  }, [widthsKey, widths]);
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
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
  const totalWidth = numberWidth + widths.reduce((a, b) => a + b, 0);

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

  function moveTo(r: number, c: number) {
    const rr = Math.max(0, Math.min(rowCount - 1, r));
    const cc = Math.max(0, Math.min(columns.length - 1, c));
    setSelected({ row: rr, col: cc });
    const el = scroller.current;
    if (el) el.scrollTop = scrollTopFor(rr, rowCount, viewport, el.scrollTop);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!selected || rowCount === 0) {
      if (editing && e.key === 'Insert' && !editing.busy) {
        e.preventDefault();
        editing.onChange((x) => addInsert(x, `new-${Date.now()}-${x.inserts.length}`));
        setSelected({ row: 0, col: 0 });
      }
      return;
    }
    const page = Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1);
    const keys: Record<string, () => void> = {
      ArrowDown: () => moveTo(selected.row + 1, selected.col),
      ArrowUp: () => moveTo(selected.row - 1, selected.col),
      ArrowRight: () => moveTo(selected.row, selected.col + 1),
      ArrowLeft: () => moveTo(selected.row, selected.col - 1),
      PageDown: () => moveTo(selected.row + page, selected.col),
      PageUp: () => moveTo(selected.row - page, selected.col),
      Home: () => moveTo(e.ctrlKey ? 0 : selected.row, 0),
      End: () => moveTo(e.ctrlKey ? rowCount - 1 : selected.row, columns.length - 1),
    };
    if (editing && !editingCell) {
      if ((e.key === 'Enter' || e.key === 'F2') && canEdit(selected.row, selected.col)) {
        e.preventDefault();
        setEditingCell({ row: selected.row, col: selected.col });
        return;
      }
      if (e.key === 'Delete' && target && !editing.busy) {
        e.preventDefault();
        if (selected.row >= baseCount) {
          const id = edits.inserts[selected.row - baseCount]?.id;
          if (id) editing.onChange((x) => removeInsert(x, id));
        } else {
          const cells = row(selected.row);
          if (cells) editing.onChange((x) => toggleDelete(x, target, cells));
        }
        return;
      }
      if (e.key === 'Insert' && !editing.busy) {
        e.preventDefault();
        editing.onChange((x) => addInsert(x, `new-${Date.now()}-${x.inserts.length}`));
        // The new row is at the old row count (moveTo would clamp to the old last row).
        setSelected({ row: rowCount, col: 0 });
        return;
      }
    }
    const action = keys[e.key];
    if (action) {
      e.preventDefault();
      action();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      const value = row(selected.row)?.[selected.col];
      if (value !== undefined) {
        e.preventDefault();
        void navigator.clipboard?.writeText(value ?? '');
      }
    }
  }

  const rows: number[] = [];
  for (let i = win.first; i < win.last; i++) rows.push(i);

  return (
    <div className="flex h-full flex-col">
      <GridToolbar
        session={session}
        outcome={outcome}
        exportName={exportName}
        rowCount={rowCount}
        error={refineError ?? error}
        refining={refining}
        refinement={refinement}
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
        aria-colcount={columns.length}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => !selected && rowCount > 0 && setSelected({ row: 0, col: 0 })}
        onScroll={(e) =>
          setScroll({ top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft })
        }
        className="relative min-h-0 flex-1 overflow-auto font-mono text-[12px] outline-none select-text"
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
              <div className="shrink-0 border-r border-border" style={{ width: numberWidth }} />
              {columns.map((c, i) => (
                <div
                  key={i}
                  role="columnheader"
                  aria-sort={sortState(refinement, i)}
                  title={
                    (c.typeName ? `${c.name} (${c.typeName})` : c.name) +
                    (onRefine ? '\nClick to sort, Shift+click to add a sort column' : '')
                  }
                  className="relative flex shrink-0 items-center gap-1.5 overflow-hidden border-r border-border px-2 font-semibold whitespace-nowrap"
                  style={{ width: widths[i] }}
                >
                  {onRefine ? (
                    <button
                      type="button"
                      disabled={refining}
                      onClick={(e) =>
                        onRefine({ ...refinement, sort: nextSort(refinement.sort, i, e.shiftKey) })
                      }
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
              ))}
            </div>
            <div className="relative overflow-hidden" style={{ height: viewport }}>
              {rows.map((r) => (
                <GridRow
                  key={r}
                  index={r}
                  top={win.shift + (r - win.first) * ROW_HEIGHT}
                  view={viewOf(r)}
                  columns={columns}
                  widths={widths}
                  numberWidth={numberWidth}
                  selectedCol={selected?.row === r ? selected.col : null}
                  onSelect={(col) => setSelected({ row: r, col })}
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
                                if (move === 'down') moveTo(er + 1, ec);
                                if (move === 'right') moveTo(er, ec + 1);
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
    </div>
  );
}

/** How one visible row should look, derived from loaded cells plus pending edits. */
interface RowView {
  cells: Cell[] | undefined;
  state: 'normal' | 'deleted' | 'inserted';
  /** Columns with a pending value (shown highlighted). */
  changed: Set<number>;
  /** Inserted rows: columns left to the server default. */
  defaults?: Set<number>;
}

function GridRow({
  index,
  top,
  view,
  columns,
  widths,
  numberWidth,
  selectedCol,
  editor,
  onSelect,
  onEdit,
}: {
  index: number;
  top: number;
  view: RowView;
  columns: ColumnInfo[];
  widths: number[];
  numberWidth: number;
  selectedCol: number | null;
  editor: { col: number; node: React.ReactNode } | null;
  onSelect(col: number): void;
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
      >
        {state === 'inserted' ? '+' : index + 1}
      </div>
      {columns.map((c, i) => {
        const v = cells?.[i];
        const numeric = c.typeName !== undefined && NUMERIC.has(c.typeName);
        const changed = view.changed.has(i);
        return (
          <div
            key={i}
            role="gridcell"
            aria-selected={selectedCol === i}
            data-changed={changed || undefined}
            onMouseDown={() => onSelect(i)}
            onDoubleClick={() => onEdit(i)}
            title={v === undefined ? undefined : (v ?? 'NULL')}
            className={clsx(
              'relative shrink-0 truncate border-r border-b border-border px-2 leading-[22px] whitespace-pre',
              numeric && 'text-right tabular-nums',
              changed && 'bg-[#d98a1f]/25',
              selectedCol === i && 'bg-selected outline outline-1 -outline-offset-1 outline-accent',
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
    if (done.current) return;
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
        className="min-w-0 flex-1 bg-transparent px-1.5 font-mono outline outline-2 -outline-offset-2 outline-accent"
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

function GridToolbar({
  session,
  outcome,
  exportName,
  rowCount,
  error,
  refining,
  refinement,
}: {
  session: SessionKey;
  outcome: RowsOutcome;
  exportName: string;
  rowCount: number;
  error: string | null;
  refining: boolean;
  refinement: Refinement;
}) {
  const [exporting, setExporting] = useState<{ format: ExportFormat; rows: number } | null>(null);
  const [result, setResult] = useState<{ ok: ExportSummary } | { error: string } | null>(null);
  const cursor = outcome.cursor;

  async function runExport(format: ExportFormat) {
    if (!cursor) return;
    setResult(null);
    setExporting({ format, rows: 0 });
    try {
      const summary = await backend.resultExport(
        session,
        cursor,
        outcome.columns,
        format,
        exportName,
        (rows) => setExporting({ format, rows }),
      );
      if (summary) setResult({ ok: summary });
    } catch (e) {
      setResult({ error: toAppError(e).message });
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-panel px-2 text-[12px] text-muted">
      <span>
        {outcome.totalRows.toLocaleString()} {outcome.totalRows === 1 ? 'row' : 'rows'}
        {!cursor &&
          outcome.truncated &&
          ` (first ${rowCount.toLocaleString()} shown; this statement cannot be paged)`}
        {(refinement.sort.length > 0 || refinement.filters.length > 0) && (
          <span className="ml-1">
            ·{refinement.filters.length > 0 && ` filtered (${refinement.filters.length})`}
            {refinement.sort.length > 0 &&
              ` sorted by ${refinement.sort.length} column${refinement.sort.length > 1 ? 's' : ''}`}
          </span>
        )}
      </span>
      {refining && (
        <span className="flex items-center gap-1" role="status">
          <LoaderCircle size={12} className="animate-spin" aria-hidden /> Re-running…
        </span>
      )}
      {error && (
        <span role="alert" className="truncate text-danger" title={error}>
          {error}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1" aria-live="polite">
        {exporting ? (
          <>
            <LoaderCircle size={12} className="animate-spin" aria-hidden />
            Exporting {exporting.format.toUpperCase()}… {exporting.rows.toLocaleString()} rows
          </>
        ) : result && 'ok' in result ? (
          <span title={result.ok.path}>
            Exported {result.ok.rows.toLocaleString()} rows to {result.ok.path.split(/[\\/]/).pop()}
          </span>
        ) : result ? (
          <span role="alert" className="text-danger">
            Export failed: {result.error}
          </span>
        ) : null}
      </span>
      {(['csv', 'json'] as const).map((f) => (
        <button
          key={f}
          type="button"
          disabled={!cursor || exporting !== null}
          onClick={() => void runExport(f)}
          title={
            cursor
              ? `Export all ${outcome.totalRows.toLocaleString()} rows as ${f.toUpperCase()}`
              : 'Only query results (SELECT…) can be exported'
          }
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg hover:bg-hover disabled:opacity-40"
        >
          <Download size={12} aria-hidden /> {f.toUpperCase()}
        </button>
      ))}
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
  if (!key) return null;
  const Icon = key.descending ? ArrowDown : ArrowUp;
  return (
    <span className="flex shrink-0 items-center text-accent" aria-hidden>
      <Icon size={11} />
      {refinement.sort.length > 1 && <span className="text-[10px]">{at + 1}</span>}
    </span>
  );
}
