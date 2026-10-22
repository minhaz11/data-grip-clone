import clsx from 'clsx';
import { ArrowDown, ArrowUp, Download, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { backend } from '../../ipc/client';
import type {
  Cell,
  ColumnInfo,
  ExportFormat,
  ExportSummary,
  Refinement,
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
  sourceId: string;
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
}

/**
 * Loads pages of a cursor-backed result on demand. Page 0 is the first page that came with the
 * outcome; results without a cursor only have that page.
 */
function usePages(sourceId: string, outcome: RowsOutcome) {
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
          .resultPage(sourceId, outcome.cursor, page * PAGE_SIZE, PAGE_SIZE)
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
    [outcome.cursor, pages, sourceId],
  );

  const row = (index: number): Cell[] | undefined =>
    pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE];
  return { row, ensure, error };
}

export function ResultGrid({
  sourceId,
  outcome,
  exportName,
  onRefine,
  refinement = NO_REFINEMENT,
  refining = false,
  refineError,
  widthsKey,
}: Props) {
  const { columns } = outcome;
  // Rows the user can browse: all of them with a cursor, otherwise only what came back.
  const rowCount = outcome.cursor ? outcome.totalRows : outcome.rows.length;
  const { row, ensure, error } = usePages(sourceId, outcome);

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
    if (!selected || rowCount === 0) return;
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
        sourceId={sourceId}
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
                  cells={row(r)}
                  columns={columns}
                  widths={widths}
                  numberWidth={numberWidth}
                  selectedCol={selected?.row === r ? selected.col : null}
                  onSelect={(col) => setSelected({ row: r, col })}
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

function GridRow({
  index,
  top,
  cells,
  columns,
  widths,
  numberWidth,
  selectedCol,
  onSelect,
}: {
  index: number;
  top: number;
  cells: Cell[] | undefined;
  columns: ColumnInfo[];
  widths: number[];
  numberWidth: number;
  selectedCol: number | null;
  onSelect(col: number): void;
}) {
  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      className="absolute left-0 flex hover:bg-hover"
      style={{ top, height: ROW_HEIGHT }}
    >
      <div
        className="shrink-0 border-r border-b border-border px-2 text-right leading-[22px] text-muted tabular-nums"
        style={{ width: numberWidth }}
      >
        {index + 1}
      </div>
      {columns.map((c, i) => {
        const v = cells?.[i];
        const numeric = c.typeName !== undefined && NUMERIC.has(c.typeName);
        return (
          <div
            key={i}
            role="gridcell"
            aria-selected={selectedCol === i}
            onMouseDown={() => onSelect(i)}
            title={v === undefined ? undefined : (v ?? 'NULL')}
            className={clsx(
              'shrink-0 truncate border-r border-b border-border px-2 leading-[22px] whitespace-pre',
              numeric && 'text-right tabular-nums',
              selectedCol === i && 'bg-selected outline outline-1 -outline-offset-1 outline-accent',
            )}
            style={{ width: widths[i] }}
          >
            {cells === undefined ? (
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

function GridToolbar({
  sourceId,
  outcome,
  exportName,
  rowCount,
  error,
  refining,
  refinement,
}: {
  sourceId: string;
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
        sourceId,
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
