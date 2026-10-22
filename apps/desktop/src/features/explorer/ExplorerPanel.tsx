import { Database, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ContextMenu, type MenuItem } from '../../components/ui/ContextMenu';
import { IconButton } from '../../components/ui/IconButton';
import type { AppError, ConnectionProfile } from '../../ipc/types';
import { shortcutLabel } from '../../lib/keymap';
import { ConnectionResult } from '../connections/ConnectionResult';
import { useConnections } from '../connections/connectionsStore';
import { askPasswordAndConnect } from '../../app/dialogs';
import { useSessions } from '../connections/sessionsStore';
import { resetCatalog } from '../editor/catalog';
import { disconnectSource, resolveTransactions } from '../exec/txGuards';
import { openTransactions } from '../exec/txStore';
import { useMetadata } from './metadataStore';
import { TreeRow } from './TreeRow';
import { flattenTree, SEP, type Row } from './treeModel';
import { useWorkspace } from '../../app/workspaceStore';
import type { ObjectRef } from '../../ipc/types';
import { QuickInfo, type QuickInfoTarget } from '../schema/QuickInfo';

interface Props {
  onNew(): void;
  onEdit(profile: ConnectionProfile): void;
}

/** Database Explorer: data sources and their lazily loaded schema tree. */
export function ExplorerPanel({ onNew, onEdit }: Props) {
  const items = useConnections((s) => s.items);
  const selectedSourceId = useConnections((s) => s.selectedId);
  const selectSource = useConnections((s) => s.select);
  const duplicate = useConnections((s) => s.duplicate);
  const remove = useConnections((s) => s.remove);
  const loadError = useConnections((s) => s.error);
  const sessions = useSessions((s) => s.byId);
  const connect = useSessions((s) => s.connect);
  const { children, expanded, setExpanded, load, refresh, resetSource } = useMetadata();

  const [filter, setFilter] = useState('');
  const [pickedKey, setSelectedKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConnectionProfile | null>(null);
  // Deleting disconnects: open transactions are resolved first.
  const askDelete = async (p: ConnectionProfile) => {
    if (await resolveTransactions(openTransactions(p.id), `Delete ${p.name}?`)) {
      setPendingDelete(p);
    }
  };
  const [actionError, setActionError] = useState<string | null>(null);
  const [quickInfo, setQuickInfo] = useState<QuickInfoTarget | null>(null);
  const [connectError, setConnectError] = useState<{ name: string; error: AppError } | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);

  const rows = useMemo(
    () => flattenTree(items, children, expanded, filter),
    [items, children, expanded, filter],
  );
  // The picked row wins while it belongs to the selected data source; when the source selection
  // changes elsewhere (e.g. a just-created or duplicated source), that source's row is selected.
  const picked = rows.find((r) => r.key === pickedKey);
  const selectedKey =
    picked && picked.profile.id === selectedSourceId ? pickedKey : selectedSourceId;
  const selectedIndex = rows.findIndex((r) => r.key === selectedKey);
  const selected = selectedIndex >= 0 ? rows[selectedIndex] : undefined;

  // Expanded levels that were never requested load as soon as they become visible.
  useEffect(() => {
    for (const r of rows)
      if (r.type === 'status' && r.needsLoad) void load(r.parentKey, r.profile.id, r.needsLoad);
  }, [rows, load]);

  // A source's tree is only valid while its session is: drop it on disconnect or loss.
  useEffect(() => {
    for (const p of items) {
      const loadedOrOpen = children[p.id] !== undefined || expanded[p.id];
      if (
        loadedOrOpen &&
        sessions[p.id]?.state !== 'connected' &&
        sessions[p.id]?.state !== 'connecting'
      ) {
        resetSource(p.id);
      }
    }
  }, [sessions, items, children, expanded, resetSource]);

  useEffect(() => {
    treeRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedKey]);

  function select(row: Row | undefined) {
    if (!row) return;
    setSelectedKey(row.key);
    if (row.profile.id !== selectedSourceId) selectSource(row.profile.id);
  }

  async function runConnect(p: ConnectionProfile): Promise<boolean> {
    setConnectError(null);
    const error = await connect(p.id);
    if (error?.connectKind === 'password_required') return askPasswordAndConnect(p);
    if (error) setConnectError({ name: p.name, error });
    return error === null;
  }

  async function runDuplicate(p: ConnectionProfile) {
    setActionError(null);
    try {
      await duplicate(p.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Expands or collapses a row; expanding a disconnected data source connects first. */
  async function toggle(row: Row, open = !isOpen(row)) {
    if (row.type === 'status') return;
    if (row.type === 'node' && !row.node.children) return;
    if (open && row.type === 'source' && sessions[row.profile.id]?.state !== 'connected') {
      if (!(await runConnect(row.profile))) return;
    }
    setExpanded(row.key, open);
  }

  function isOpen(row: Row) {
    return row.type !== 'status' && row.expanded;
  }

  function refreshRow(row: Row) {
    if (row.type === 'status') return;
    if (row.type === 'source' && sessions[row.profile.id]?.state !== 'connected') return;
    refresh(row.key);
    resetCatalog(row.profile.id); // completion re-reads the catalog too
  }

  /** The table, view or materialized view a node stands for, if it is one. */
  function objectOf(row: Row | undefined): ObjectRef | null {
    if (row?.type !== 'node' || row.node.children?.level !== 'objectGroups') {
      return null;
    }
    const { schema, name, objectType } = row.node.children;
    return { schema, name, objectType };
  }

  /** What Quick info shows for a row: a table-like object, or a column with its table. */
  function quickInfoOf(row: Row | undefined): QuickInfoTarget | null {
    if (row?.type !== 'node') {
      return null;
    }
    const object = objectOf(row);
    if (object) {
      return { sourceId: row.profile.id, object };
    }
    if (row.node.kind === 'column') {
      // A column's parent is its table's "Columns" group.
      const tableKey = row.parentKey.slice(0, row.parentKey.lastIndexOf(SEP));
      const table = objectOf(rows.find((r) => r.key === tableKey));
      return table ? { sourceId: row.profile.id, object: table, column: row.node.name } : null;
    }
    return null;
  }

  function openViewer(row: Row): boolean {
    const object = objectOf(row);
    if (!object) {
      return false;
    }
    useWorkspace.getState().openObject(row.profile.id, object);
    return true;
  }

  function menuItems(row: Row): MenuItem[] {
    const refreshItem: MenuItem = {
      label: 'Refresh',
      shortcut: 'Ctrl+F5',
      onSelect: () => refreshRow(row),
    };
    if (row.type === 'node') {
      const info = quickInfoOf(row);
      return [
        ...(objectOf(row)
          ? [{ label: 'Open table viewer', shortcut: 'Enter', onSelect: () => openViewer(row) }]
          : []),
        ...(info
          ? [{ label: 'Quick info', shortcut: 'Ctrl+Q', onSelect: () => setQuickInfo(info) }]
          : []),
        refreshItem,
        { label: 'Copy name', onSelect: () => void navigator.clipboard?.writeText(row.node.name) },
      ];
    }
    const p = row.profile;
    const state = sessions[p.id]?.state;
    const live = state === 'connected' || state === 'connecting';
    return [
      live
        ? { label: 'Disconnect', onSelect: () => void disconnectSource(p.id) }
        : { label: 'Connect', onSelect: () => void runConnect(p) },
      ...(state === 'connected' ? [refreshItem] : []),
      { label: 'Properties…', shortcut: 'Enter', onSelect: () => onEdit(p) },
      { label: 'Duplicate', shortcut: 'Ctrl+D', onSelect: () => void runDuplicate(p) },
      { label: 'Delete…', shortcut: 'Delete', danger: true, onSelect: () => void askDelete(p) },
    ];
  }

  function onTreeKeyDown(e: React.KeyboardEvent) {
    const move = (i: number) => select(rows[Math.max(0, Math.min(rows.length - 1, i))]);
    const row = selected;
    if (e.key === 'ArrowDown') move(selectedIndex + 1);
    else if (e.key === 'ArrowUp') move(selectedIndex < 0 ? 0 : selectedIndex - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(rows.length - 1);
    else if (!row) return;
    else if (e.key === 'ArrowRight') {
      if (row.type !== 'status' && !row.expanded) void toggle(row, true);
      else if (rows[selectedIndex + 1]?.level === row.level + 1) move(selectedIndex + 1);
    } else if (e.key === 'ArrowLeft') {
      if (row.type !== 'status' && row.expanded) void toggle(row, false);
      else if (row.type !== 'source') select(rows.find((r) => r.key === row.parentKey));
    } else if (e.key === 'Enter') {
      if (row.type === 'source') onEdit(row.profile);
      else if (!openViewer(row)) void toggle(row);
    } else if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'q') {
      // Control only: Cmd+Q quits on macOS.
      const info = quickInfoOf(row);
      if (info) setQuickInfo(info);
    } else if (e.key === 'F5' && e.ctrlKey) refreshRow(row);
    else if (row.type === 'source' && e.key === 'Delete') void askDelete(row.profile);
    else if (row.type === 'source' && e.ctrlKey && e.key.toLowerCase() === 'd')
      void runDuplicate(row.profile);
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const rect = treeRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.getBoundingClientRect();
      setMenu({ x: (rect?.left ?? 0) + 24, y: rect?.bottom ?? 0, row });
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

      {items.length > 0 && (
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1">
          <Search size={13} className="shrink-0 text-muted" aria-hidden />
          <input
            type="search"
            aria-label="Filter loaded objects"
            placeholder="Filter loaded objects"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.stopPropagation();
                setFilter('');
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                treeRef.current?.focus();
                if (!selected) select(rows[0]);
              }
            }}
            className="min-w-0 flex-1 bg-transparent py-0.5 outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
          />
          {filter && (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => setFilter('')}
              className="rounded p-0.5 text-muted hover:bg-hover"
            >
              <X size={12} aria-hidden />
            </button>
          )}
        </div>
      )}

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
          aria-activedescendant={selected ? `tree-row-${selectedIndex}` : undefined}
          onKeyDown={onTreeKeyDown}
          onFocus={() => !selected && select(rows[0])}
          className="@container flex-1 overflow-auto py-1 outline-none"
        >
          {rows.map((row, i) => (
            <TreeRow
              key={row.key}
              id={`tree-row-${i}`}
              row={row}
              selected={row.key === selectedKey}
              session={sessions[row.profile.id]}
              highlight={filter.trim()}
              onSelect={() => select(row)}
              onToggle={() => void toggle(row)}
              onActivate={() => {
                if (row.type === 'source') onEdit(row.profile);
                else if (!openViewer(row)) void toggle(row);
              }}
              onContextMenu={(x, y) => {
                select(row);
                if (row.type !== 'status') setMenu({ x, y, row });
              }}
              onRetry={() => row.type === 'status' && refresh(row.parentKey)}
            />
          ))}
          {filter && rows.length === 0 && (
            <li className="px-3 py-2 text-muted">No loaded objects match “{filter}”.</li>
          )}
        </ul>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`${menu.row.type === 'node' ? menu.row.node.name : menu.row.profile.name} actions`}
          items={menuItems(menu.row)}
          onClose={() => setMenu(null)}
        />
      )}
      {quickInfo && <QuickInfo target={quickInfo} onClose={() => setQuickInfo(null)} />}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete Data Source"
          confirmLabel="Delete"
          danger
          onClose={() => setPendingDelete(null)}
          onConfirm={async () => {
            resetSource(pendingDelete.id);
            await remove(pendingDelete.id);
          }}
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
