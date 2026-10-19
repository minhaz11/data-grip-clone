import clsx from 'clsx';
import { Database, Lock, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ContextMenu, type MenuItem } from '../../components/ui/ContextMenu';
import { IconButton } from '../../components/ui/IconButton';
import type { AppError, ConnectionProfile } from '../../ipc/types';
import { shortcutLabel } from '../../lib/keymap';
import { ConnectionResult } from '../connections/ConnectionResult';
import { useConnections } from '../connections/connectionsStore';
import { PasswordPrompt } from '../connections/PasswordPrompt';
import { useSessions, type SessionState } from '../connections/sessionsStore';
import { effectiveColor, endpointLabel, ENVIRONMENTS } from '../connections/model';

interface Props {
  onNew(): void;
  onEdit(profile: ConnectionProfile): void;
}

/** Database Explorer: data sources (M2.1). Schema children load lazily from M2.3. */
export function ExplorerPanel({ onNew, onEdit }: Props) {
  const items = useConnections((s) => s.items);
  const selectedId = useConnections((s) => s.selectedId);
  const select = useConnections((s) => s.select);
  const duplicate = useConnections((s) => s.duplicate);
  const remove = useConnections((s) => s.remove);
  const loadError = useConnections((s) => s.error);
  const [menu, setMenu] = useState<{ x: number; y: number; profile: ConnectionProfile } | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<ConnectionProfile | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const sessions = useSessions((s) => s.byId);
  const connect = useSessions((s) => s.connect);
  const disconnect = useSessions((s) => s.disconnect);
  const [connectError, setConnectError] = useState<{ name: string; error: AppError } | null>(null);
  const [passwordFor, setPasswordFor] = useState<ConnectionProfile | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);

  const selected = items.find((c) => c.id === selectedId) ?? null;

  async function runDuplicate(p: ConnectionProfile) {
    setActionError(null);
    try {
      await duplicate(p.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runConnect(p: ConnectionProfile) {
    setConnectError(null);
    const error = await connect(p.id);
    if (error?.connectKind === 'password_required') setPasswordFor(p);
    else if (error) setConnectError({ name: p.name, error });
  }

  function menuItems(p: ConnectionProfile): MenuItem[] {
    const state = sessions[p.id]?.state;
    const live = state === 'connected' || state === 'connecting';
    return [
      live
        ? { label: 'Disconnect', onSelect: () => void disconnect(p.id) }
        : { label: 'Connect', onSelect: () => void runConnect(p) },
      { label: 'Properties…', shortcut: 'Enter', onSelect: () => onEdit(p) },
      { label: 'Duplicate', shortcut: 'Ctrl+D', onSelect: () => void runDuplicate(p) },
      { label: 'Delete…', shortcut: 'Delete', danger: true, onSelect: () => setPendingDelete(p) },
    ];
  }

  function onTreeKeyDown(e: React.KeyboardEvent) {
    const index = items.findIndex((c) => c.id === selectedId);
    const move = (i: number) => {
      const next = items[Math.max(0, Math.min(items.length - 1, i))];
      if (next) select(next.id);
    };
    if (e.key === 'ArrowDown') move(index + 1);
    else if (e.key === 'ArrowUp') move(index < 0 ? 0 : index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if (selected && e.key === 'Enter') onEdit(selected);
    else if (selected && e.key === 'Delete') setPendingDelete(selected);
    else if (selected && e.ctrlKey && e.key.toLowerCase() === 'd') void runDuplicate(selected);
    else if (selected && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
      const row = treeRef.current
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.getBoundingClientRect();
      setMenu({ x: (row?.left ?? 0) + 24, y: row?.bottom ?? 0, profile: selected });
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <section aria-label="Database Explorer" className="flex h-full flex-col bg-panel">
      <header className="flex h-8 shrink-0 items-center border-b border-border pl-3 pr-1">
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Database Explorer
        </h2>
        <IconButton
          label="New data source"
          shortcut={shortcutLabel('datasource.new')}
          onClick={onNew}
        >
          <Plus size={15} aria-hidden />
        </IconButton>
      </header>

      {connectError && (
        <div className="border-b border-border p-2">
          <p className="mb-1 flex items-center justify-between text-[11px] text-muted">
            <span>{connectError.name}</span>
            <button type="button" className="underline" onClick={() => setConnectError(null)}>
              Dismiss
            </button>
          </p>
          <ConnectionResult result={{ error: connectError.error }} />
        </div>
      )}

      {(loadError || actionError) && (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-danger">
          {actionError ?? loadError}
        </p>
      )}

      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-muted">
          <Database size={28} strokeWidth={1.5} aria-hidden />
          <p>No data sources configured.</p>
          <button
            type="button"
            onClick={onNew}
            className="rounded border border-border px-3 py-1 text-fg hover:bg-hover"
          >
            New data source <span className="text-muted">({shortcutLabel('datasource.new')})</span>
          </button>
        </div>
      ) : (
        <ul
          ref={treeRef}
          role="tree"
          aria-label="Data sources"
          tabIndex={0}
          aria-activedescendant={selected ? `ds-${selected.id}` : undefined}
          onKeyDown={onTreeKeyDown}
          onFocus={() => !selected && items[0] && select(items[0].id)}
          className="@container flex-1 overflow-auto py-1 outline-none"
        >
          {items.map((c) => {
            const color = effectiveColor(c);
            const env = ENVIRONMENTS.find((e) => e.value === c.environment);
            const session = sessions[c.id];
            return (
              <li
                key={c.id}
                id={`ds-${c.id}`}
                role="treeitem"
                aria-selected={c.id === selectedId}
                aria-label={`${c.name}${c.readOnly ? ', read-only' : ''}${c.environment !== 'none' ? `, ${env?.label}` : ''}${sessionLabel(session)}`}
                onClick={() => select(c.id)}
                onDoubleClick={() => onEdit(c)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  select(c.id);
                  setMenu({ x: e.clientX, y: e.clientY, profile: c });
                }}
                className={clsx(
                  'flex cursor-default items-center gap-2 border-l-[3px] py-[3px] pl-2 pr-2',
                  c.id === selectedId ? 'bg-selected' : 'hover:bg-hover',
                )}
                style={{ borderLeftColor: color ?? 'transparent' }}
                title={`${c.name} — ${c.username}@${endpointLabel(c)}`}
              >
                <span className="relative shrink-0">
                  <Database size={14} className="text-accent" aria-hidden />
                  {session && (
                    <span
                      aria-hidden
                      title={sessionLabel(session).slice(2)}
                      className={clsx(
                        'absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-panel',
                        session.state === 'connected' && 'bg-[#3f9d5a]',
                        session.state === 'connecting' && 'animate-pulse bg-[#d98a1f]',
                        (session.state === 'failed' || session.state === 'lost') && 'bg-danger',
                      )}
                    />
                  )}
                </span>
                <span className="min-w-0 truncate">{c.name}</span>
                {c.readOnly && <Lock size={12} className="shrink-0 text-muted" aria-hidden />}
                {c.environment === 'production' && (
                  <span
                    className="shrink-0 rounded px-1 text-[10px] font-semibold uppercase text-white"
                    style={{ background: color ?? undefined }}
                  >
                    prod
                  </span>
                )}
                <span className="ml-auto hidden min-w-0 shrink-[4] truncate pl-2 text-[11px] text-muted @[300px]:inline">
                  {endpointLabel(c)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`${menu.profile.name} actions`}
          items={menuItems(menu.profile)}
          onClose={() => setMenu(null)}
        />
      )}
      {passwordFor && <PasswordPrompt profile={passwordFor} onClose={() => setPasswordFor(null)} />}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete Data Source"
          confirmLabel="Delete"
          danger
          onClose={() => setPendingDelete(null)}
          onConfirm={() => remove(pendingDelete.id)}
        >
          <p>
            Delete <strong>{pendingDelete.name}</strong>? This cannot be undone.
          </p>
          {pendingDelete.passwordSaved && (
            <p className="text-muted">Its saved password will also be removed.</p>
          )}
        </ConfirmDialog>
      )}
    </section>
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
