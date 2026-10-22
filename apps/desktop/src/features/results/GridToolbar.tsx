import { Columns3, Copy, Download, LoaderCircle } from 'lucide-react';
import type { Refinement, StatementOutcome } from '../../ipc/types';

type RowsOutcome = Extract<StatementOutcome, { type: 'rows' }>;

/** A running export or whole-result copy, or how the last one ended. */
export type OutputStatus =
  | { kind: 'running'; job: string; label: string; rows: number }
  | { kind: 'done'; text: string; title?: string }
  | { kind: 'error'; text: string }
  | null;

interface Props {
  outcome: RowsOutcome;
  rowCount: number;
  error: string | null;
  refining: boolean;
  refinement: Refinement;
  status: OutputStatus;
  hiddenColumns: number;
  onCopy(): void;
  onExport(): void;
  onColumns(anchor: HTMLElement): void;
  onCancel(job: string): void;
}

export function GridToolbar({
  outcome,
  rowCount,
  error,
  refining,
  refinement,
  status,
  hiddenColumns,
  onCopy,
  onExport,
  onColumns,
  onCancel,
}: Props) {
  const cursor = outcome.cursor;
  const running = status?.kind === 'running';
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-panel px-2 text-[12px] text-muted">
      <span className="shrink-0">
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
        {hiddenColumns > 0 && (
          <span className="ml-1">
            · {hiddenColumns} hidden {hiddenColumns === 1 ? 'column' : 'columns'}
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
      <span className="ml-auto flex min-w-0 items-center gap-1" aria-live="polite">
        {status?.kind === 'running' ? (
          <>
            <LoaderCircle size={12} className="animate-spin" aria-hidden />
            <span className="truncate">
              {status.label}… {status.rows.toLocaleString()} rows
            </span>
            <button
              type="button"
              onClick={() => onCancel(status.job)}
              className="rounded border border-border px-1.5 text-fg hover:bg-hover"
            >
              Cancel
            </button>
          </>
        ) : status?.kind === 'done' ? (
          <span className="truncate" title={status.title}>
            {status.text}
          </span>
        ) : status?.kind === 'error' ? (
          <span role="alert" className="truncate text-danger" title={status.text}>
            {status.text}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        onClick={(e) => onColumns(e.currentTarget)}
        title="Show, hide and reorder columns"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg hover:bg-hover"
      >
        <Columns3 size={12} aria-hidden /> Columns
      </button>
      <button
        type="button"
        onClick={onCopy}
        disabled={running}
        title="Copy the selection, a page or the whole result in a chosen format"
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg hover:bg-hover disabled:opacity-40"
      >
        <Copy size={12} aria-hidden /> Copy…
      </button>
      <button
        type="button"
        disabled={!cursor || running}
        onClick={onExport}
        title={
          cursor
            ? `Export all ${outcome.totalRows.toLocaleString()} rows`
            : 'Only query results (SELECT…) can be exported'
        }
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg hover:bg-hover disabled:opacity-40"
      >
        <Download size={12} aria-hidden /> Export…
      </button>
    </div>
  );
}
