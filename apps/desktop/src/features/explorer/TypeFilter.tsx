import { ListFilter } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MetaKind } from '../../ipc/types';

/** Object kinds the explorer can hide, as the type filter lists them. */
export const FILTERABLE: { kind: MetaKind; label: string }[] = [
  { kind: 'table', label: 'Tables' },
  { kind: 'view', label: 'Views' },
  { kind: 'materialized_view', label: 'Materialized views' },
  { kind: 'routine', label: 'Routines' },
  { kind: 'sequence', label: 'Sequences' },
  { kind: 'column', label: 'Columns' },
  { kind: 'index', label: 'Indexes' },
  { kind: 'key', label: 'Keys' },
  { kind: 'foreign_key', label: 'Foreign keys' },
  { kind: 'check', label: 'Checks' },
  { kind: 'trigger', label: 'Triggers' },
];

/** A button that opens checkboxes for which object kinds the tree shows. */
export function TypeFilter({
  hidden,
  onChange,
}: {
  hidden: ReadonlySet<MetaKind>;
  onChange(hidden: Set<MetaKind>): void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    ref.current?.querySelector<HTMLElement>('input')?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointer, true);
    return () => window.removeEventListener('pointerdown', onPointer, true);
  }, [open]);

  const toggle = (kind: MetaKind, shown: boolean) => {
    const next = new Set(hidden);
    if (shown) {
      next.delete(kind);
    } else {
      next.add(kind);
    }
    onChange(next);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`Filter object types${hidden.size ? ` (${hidden.size} hidden)` : ''}`}
        title="Filter object types"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`rounded p-1 hover:bg-hover ${hidden.size ? 'text-accent' : 'text-muted'}`}
      >
        <ListFilter size={14} aria-hidden />
      </button>
      {open && (
        <div
          role="group"
          aria-label="Object types to show"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
              ref.current?.querySelector<HTMLElement>('button')?.focus();
            }
          }}
          className="absolute right-0 top-full z-30 mt-1 w-48 rounded border border-border bg-panel p-2 shadow-lg"
        >
          {FILTERABLE.map(({ kind, label }) => (
            <label key={kind} className="flex items-center gap-2 py-0.5">
              <input
                type="checkbox"
                checked={!hidden.has(kind)}
                onChange={(e) => toggle(kind, e.target.checked)}
              />
              {label}
            </label>
          ))}
          {hidden.size > 0 && (
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="mt-1 text-[12px] text-muted underline"
            >
              Show all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
