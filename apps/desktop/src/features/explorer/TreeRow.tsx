import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Database,
  Eye,
  Folder as FolderIcon,
  FolderClosed,
  FolderOpen,
  KeyRound,
  Network,
  Layers,
  Link2,
  ListOrdered,
  LoaderCircle,
  Lock,
  Rows3,
  ShieldCheck,
  SquareFunction,
  Table2,
  Workflow,
  Zap,
} from 'lucide-react';
import type { MetaKind } from '../../ipc/types';
import type { SessionState } from '../connections/sessionsStore';
import { effectiveColor, endpointLabel, ENVIRONMENTS, readableTextOn } from '../connections/model';
import type { Row } from './treeModel';

const INDENT = 14;

const KIND_ICON: Record<MetaKind, typeof Table2> = {
  schema: Layers,
  group: FolderClosed,
  table: Table2,
  view: Eye,
  materialized_view: Rows3,
  column: Columns3,
  index: Zap,
  key: KeyRound,
  foreign_key: Link2,
  check: ShieldCheck,
  trigger: Workflow,
  routine: SquareFunction,
  sequence: ListOrdered,
};

const KIND_LABEL: Record<MetaKind, string> = {
  schema: 'schema',
  group: 'folder',
  table: 'table',
  view: 'view',
  materialized_view: 'materialized view',
  column: 'column',
  index: 'index',
  key: 'key',
  foreign_key: 'foreign key',
  check: 'check constraint',
  trigger: 'trigger',
  routine: 'routine',
  sequence: 'sequence',
};

/** MIME type of a data source being dragged within the explorer. */
export const DRAG_TYPE = 'application/x-quarry-data-source';

interface Props {
  id: string;
  row: Row;
  selected: boolean;
  session: SessionState | undefined;
  highlight: string;
  onSelect(): void;
  onToggle(): void;
  onActivate(): void;
  onContextMenu(x: number, y: number): void;
  onRetry(): void;
  /** Shows an inline name editor; `onRename(null)` cancels. */
  renaming?: boolean;
  onRename?(name: string | null): void;
  /** "N of M schemas" (or similar) for a data source with a schema scope. */
  scopeLabel?: string | null;
  /** Data source rows can be dragged; folder and data source rows accept drops. */
  onDragSource?(): void;
  onDropSource?(): void;
}

export function TreeRow({
  id,
  row,
  selected,
  session,
  highlight,
  onSelect,
  onToggle,
  onActivate,
  onContextMenu,
  onRetry,
  renaming = false,
  onRename,
  scopeLabel,
  onDragSource,
  onDropSource,
}: Props) {
  const pad = { paddingLeft: 6 + (row.level - 1) * INDENT };
  const [dropping, setDropping] = useState(false);

  if (row.type === 'status') {
    return (
      <li
        id={id}
        role="treeitem"
        aria-level={row.level}
        aria-selected={selected}
        onClick={onSelect}
        className={clsx(
          'flex items-center gap-1.5 py-[3px] pr-2 text-muted',
          selected && 'bg-selected',
        )}
        style={{ paddingLeft: pad.paddingLeft + 18 }}
      >
        {row.status === 'loading' && (
          <>
            <LoaderCircle size={12} className="animate-spin" aria-hidden /> Loading…
          </>
        )}
        {row.status === 'empty' && <span className="italic">Empty</span>}
        {row.status === 'error' && row.error && (
          <span
            className="min-w-0 truncate text-danger"
            title={[row.error.message, row.error.hint].filter(Boolean).join('\n')}
          >
            {row.error.message}{' '}
            <button type="button" className="text-accent underline" onClick={onRetry}>
              Retry
            </button>
          </span>
        )}
      </li>
    );
  }

  const expandable =
    row.type === 'source' || row.type === 'folder' || row.node.children !== undefined;
  const Chevron = row.expanded ? ChevronDown : ChevronRight;
  const dropTarget =
    onDropSource && (row.type === 'folder' || row.type === 'source')
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (e.dataTransfer.types.includes(DRAG_TYPE)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropping(true);
            }
          },
          onDragLeave: () => setDropping(false),
          onDrop: (e: React.DragEvent) => {
            setDropping(false);
            if (e.dataTransfer.types.includes(DRAG_TYPE)) {
              e.preventDefault();
              e.stopPropagation();
              onDropSource();
            }
          },
        }
      : {};
  const common = {
    ...dropTarget,
    id,
    role: 'treeitem' as const,
    'aria-level': row.level,
    'aria-selected': selected,
    'aria-expanded': expandable ? row.expanded : undefined,
    'aria-posinset': row.posinset,
    'aria-setsize': row.setsize,
    onClick: onSelect,
    onDoubleClick: onActivate,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      onContextMenu(e.clientX, e.clientY);
    },
  };
  const chevron = expandable ? (
    <span
      role="presentation"
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
        onToggle();
      }}
      className="flex w-4 shrink-0 justify-center text-muted hover:text-fg"
    >
      <Chevron size={13} aria-hidden />
    </span>
  ) : (
    <span className="w-4 shrink-0" />
  );

  const name = (text: string) =>
    renaming && onRename ? (
      <RenameInput initial={text} onDone={onRename} />
    ) : (
      <Name text={text} highlight={highlight} />
    );

  if (row.type === 'folder') {
    const f = row.folder;
    const Icon = row.expanded ? FolderOpen : FolderIcon;
    return (
      <li
        {...common}
        aria-label={`${f.name}, folder, ${row.count} data source${row.count === 1 ? '' : 's'}`}
        className={clsx(
          'flex cursor-default items-center gap-1.5 border-l-[3px] py-[3px] pr-2',
          selected ? 'bg-selected' : 'hover:bg-hover',
          dropping && 'outline outline-1 -outline-offset-1 outline-accent',
        )}
        style={{ ...pad, paddingLeft: 3, borderLeftColor: f.color ?? 'transparent' }}
        title={f.name}
      >
        {chevron}
        <Icon size={14} className="shrink-0 text-muted" aria-hidden />
        {name(f.name)}
        <span className="shrink-0 text-[11px] text-muted">{row.count}</span>
      </li>
    );
  }

  if (row.type === 'source') {
    const c = row.profile;
    const color = effectiveColor(c);
    const env = ENVIRONMENTS.find((e) => e.value === c.environment);
    return (
      <li
        {...common}
        draggable={!!onDragSource && !renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, c.id);
          e.dataTransfer.effectAllowed = 'move';
          onDragSource?.();
        }}
        aria-label={`${c.name}${c.readOnly ? ', read-only' : ''}${c.environment !== 'none' ? `, ${env?.label}` : ''}${c.sshProfileId ? ', via SSH tunnel' : ''}${scopeLabel ? `, ${scopeLabel}` : ''}${sessionLabel(session)}`}
        className={clsx(
          'flex cursor-default items-center gap-1.5 border-l-[3px] py-[3px] pr-2',
          selected ? 'bg-selected' : 'hover:bg-hover',
          dropping && 'shadow-[inset_0_2px_0_0_var(--color-accent)]',
        )}
        style={{
          ...pad,
          paddingLeft: 3 + (row.level - 1) * INDENT,
          borderLeftColor: color ?? 'transparent',
        }}
        title={`${c.name}: ${c.username}@${endpointLabel(c)}${c.sshProfileId ? ' (SSH tunnel)' : ''}`}
      >
        {chevron}
        <span className="relative shrink-0">
          <Database size={14} className="text-accent" aria-hidden />
          {session && (
            <span
              aria-hidden
              className={clsx(
                'absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-panel',
                session.state === 'connected' && 'bg-[#3f9d5a]',
                session.state === 'connecting' && 'animate-pulse bg-[#d98a1f]',
                (session.state === 'failed' || session.state === 'lost') && 'bg-danger',
              )}
            />
          )}
        </span>
        {name(c.name)}
        {c.readOnly && <Lock size={12} className="shrink-0 text-muted" aria-hidden />}
        {c.sshProfileId && <Network size={12} className="shrink-0 text-muted" aria-hidden />}
        {c.environment === 'production' && (
          <span
            className="shrink-0 rounded bg-danger px-1 text-[10px] font-semibold uppercase text-danger-fg"
            style={color ? { background: color, color: readableTextOn(color) } : undefined}
          >
            prod
          </span>
        )}
        {scopeLabel && (
          <span className="shrink-0 rounded bg-panel-2 px-1 text-[10px] text-muted">
            {scopeLabel}
          </span>
        )}
        <span className="ml-auto hidden min-w-0 shrink-[50] truncate pl-2 text-[11px] text-muted @[300px]:inline">
          {endpointLabel(c)}
        </span>
      </li>
    );
  }

  const n = row.node;
  const isPk = n.kind === 'column' && n.flags?.includes('pk');
  const Icon = isPk ? KeyRound : KIND_ICON[n.kind];
  const flags = (n.flags ?? []).filter((f) => f !== 'pk');
  return (
    <li
      {...common}
      aria-label={`${n.name}, ${KIND_LABEL[n.kind]}${n.count !== undefined ? `, ${n.count}` : ''}${n.detail ? `, ${n.detail}` : ''}${flags.length ? `, ${flags.join(', ')}` : ''}${isPk ? ', primary key' : ''}`}
      className={clsx(
        'flex cursor-default items-center gap-1.5 py-[3px] pr-2',
        selected ? 'bg-selected' : 'hover:bg-hover',
      )}
      style={pad}
      title={n.detail ? `${n.name}: ${n.detail}` : n.name}
    >
      {chevron}
      <Icon
        size={13}
        className={clsx(
          'shrink-0',
          isPk ? 'text-[#d98a1f]' : n.kind === 'group' ? 'text-muted' : 'text-accent',
        )}
        aria-hidden
      />
      <Name text={n.name} highlight={highlight} />
      {n.count !== undefined && <span className="shrink-0 text-[11px] text-muted">{n.count}</span>}
      {flags.map((f) => (
        <span key={f} className="shrink-0 rounded bg-panel-2 px-1 text-[10px] text-muted">
          {f}
        </span>
      ))}
      {n.detail && (
        // Detail yields space to the name first (shrink weight 50 vs 1). Comments on schemas and
        // objects are secondary: only shown when the panel is wide; always in the tooltip.
        <span
          className={clsx(
            'min-w-0 shrink-[50] truncate pl-1 font-mono text-[11px] text-muted',
            n.kind !== 'column' && n.kind !== 'index' && 'hidden @[380px]:inline',
          )}
        >
          {n.detail}
        </span>
      )}
    </li>
  );
}

/** Inline name editor: Enter or leaving the field saves, Escape cancels. */
function RenameInput({ initial, onDone }: { initial: string; onDone(name: string | null): void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (!done.current) {
      done.current = true;
      onDone(name);
    }
  };
  return (
    <input
      ref={ref}
      aria-label="New name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Keys stay in the field: the tree must not navigate or run actions while renaming.
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(value.trim() && value.trim() !== initial ? value.trim() : null);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(value.trim() && value.trim() !== initial ? value.trim() : null)}
      className="min-w-0 flex-1 rounded border border-accent bg-bg px-1 py-0 text-fg outline-none"
    />
  );
}

/** Name with the filter match emphasized. */
function Name({ text, highlight }: { text: string; highlight: string }) {
  const i = highlight ? text.toLowerCase().indexOf(highlight.toLowerCase()) : -1;
  if (i < 0) return <span className="min-w-0 shrink truncate">{text}</span>;
  return (
    <span className="min-w-0 shrink truncate">
      {text.slice(0, i)}
      <mark className="rounded-sm bg-[#f5d77a] text-black">
        {text.slice(i, i + highlight.length)}
      </mark>
      {text.slice(i + highlight.length)}
    </span>
  );
}

function sessionLabel(s: SessionState | undefined): string {
  switch (s?.state) {
    case 'connected':
      return `, connected (PostgreSQL ${s.info.serverVersion})`;
    case 'connecting':
      return ', connecting';
    case 'failed':
      return ', connection failed';
    case 'lost':
      return `, connection lost: ${s.reason}`;
    default:
      return '';
  }
}
