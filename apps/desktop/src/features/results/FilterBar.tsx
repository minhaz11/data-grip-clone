import { Filter as FilterIcon, Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { ColumnInfo, Filter, FilterOp } from '../../ipc/types';
import { FILTER_OPS, needsValue, opLabel } from './refineModel';

interface Props {
  columns: ColumnInfo[];
  filters: Filter[];
  busy: boolean;
  onChange(filters: Filter[]): void;
}

/** Server-side filter conditions (combined with AND), shown as removable chips. */
export function FilterBar({ columns, filters, busy, onChange }: Props) {
  const [adding, setAdding] = useState(false);
  const [column, setColumn] = useState(0);
  const [op, setOp] = useState<FilterOp>('eq');
  const [value, setValue] = useState('');

  function add() {
    if (needsValue(op) && value === '') return;
    onChange([...filters, { column, op, value: needsValue(op) ? value : null }]);
    setAdding(false);
    setValue('');
  }

  return (
    <div
      role="group"
      aria-label="Filters"
      className="flex min-h-7 shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-0.5 text-[12px]"
    >
      <FilterIcon size={12} className="text-muted" aria-hidden />
      {filters.length === 0 && !adding && <span className="text-muted">No filters</span>}
      {filters.map((f, i) => (
        <span
          key={i}
          className="flex items-center gap-1 rounded border border-border bg-bg px-1.5 py-px font-mono"
        >
          <span>{columns[f.column]?.name ?? `#${f.column + 1}`}</span>
          <span className="text-muted">{opLabel(f.op)}</span>
          {f.value !== null && <span className="max-w-48 truncate">{f.value}</span>}
          <button
            type="button"
            disabled={busy}
            aria-label={`Remove filter on ${columns[f.column]?.name ?? f.column + 1}`}
            onClick={() => onChange(filters.filter((_, j) => j !== i))}
            className="rounded text-muted hover:text-fg disabled:opacity-40"
          >
            <X size={11} aria-hidden />
          </button>
        </span>
      ))}
      {adding ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setAdding(false);
            }
          }}
        >
          <select
            aria-label="Filter column"
            value={column}
            onChange={(e) => setColumn(Number(e.target.value))}
            className="rounded border border-border bg-bg px-1 py-px"
          >
            {columns.map((c, i) => (
              <option key={i} value={i}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter operator"
            value={op}
            onChange={(e) => setOp(e.target.value as FilterOp)}
            className="rounded border border-border bg-bg px-1 py-px"
          >
            {FILTER_OPS.map((o) => (
              <option key={o.op} value={o.op}>
                {o.label}
              </option>
            ))}
          </select>
          {needsValue(op) && (
            <input
              aria-label="Filter value"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-40 rounded border border-border bg-bg px-1.5 py-px font-mono"
            />
          )}
          <button
            type="submit"
            disabled={busy || (needsValue(op) && value === '')}
            className="rounded bg-accent px-2 py-px text-accent-fg disabled:opacity-50"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="rounded px-1.5 py-px hover:bg-hover"
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setAdding(true)}
          className="flex items-center gap-0.5 rounded px-1.5 py-px hover:bg-hover disabled:opacity-40"
        >
          <Plus size={12} aria-hidden /> Filter
        </button>
      )}
      {filters.length > 0 && !adding && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onChange([])}
          className="ml-auto rounded px-1.5 py-px text-muted hover:bg-hover disabled:opacity-40"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
