import clsx from 'clsx';
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Database,
  Eye,
  FolderClosed,
  KeyRound,
  Layers,
  LoaderCircle,
  Lock,
  Rows3,
  Table2,
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
};

const KIND_LABEL: Record<MetaKind, string> = {
  schema: 'schema',
  group: 'folder',
  table: 'table',
  view: 'view',
  materialized_view: 'materialized view',
  column: 'column',
  index: 'index',
};

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
}: Props) {
  const pad = { paddingLeft: 6 + (row.level - 1) * INDENT };

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

  const expandable = row.type === 'source' || row.node.children !== undefined;
  const Chevron = row.expanded ? ChevronDown : ChevronRight;
  const common = {
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

  if (row.type === 'source') {
    const c = row.profile;
    const color = effectiveColor(c);
    const env = ENVIRONMENTS.find((e) => e.value === c.environment);
    return (
      <li
        {...common}
        aria-label={`${c.name}${c.readOnly ? ', read-only' : ''}${c.environment !== 'none' ? `, ${env?.label}` : ''}${sessionLabel(session)}`}
        className={clsx(
          'flex cursor-default items-center gap-1.5 border-l-[3px] py-[3px] pr-2',
          selected ? 'bg-selected' : 'hover:bg-hover',
        )}
        style={{ ...pad, paddingLeft: 3, borderLeftColor: color ?? 'transparent' }}
        title={`${c.name} — ${c.username}@${endpointLabel(c)}`}
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
        <Name text={c.name} highlight={highlight} />
        {c.readOnly && <Lock size={12} className="shrink-0 text-muted" aria-hidden />}
        {c.environment === 'production' && (
          <span
            className="shrink-0 rounded bg-danger px-1 text-[10px] font-semibold uppercase text-danger-fg"
            style={color ? { background: color, color: readableTextOn(color) } : undefined}
          >
            prod
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
