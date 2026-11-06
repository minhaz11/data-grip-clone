import { Ban, CircleCheck, CircleX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { askConfirm } from '../../app/dialogs';
import { errorMessage } from '../../app/settingsStore';
import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { Modal } from '../../components/ui/Modal';
import { backend } from '../../ipc/client';
import type { HistoryEntry, HistoryExportFormat, HistoryStatus } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { activeEditor } from '../editor/editorHandle';
import { useNotifications } from '../notifications/notifications';
import { formatMs } from '../results/BottomPanel';

/** Entries fetched per page; "Load more" fetches the next one. */
export const HISTORY_PAGE = 100;
const SEARCH_DEBOUNCE_MS = 150;

const STATUS: Record<
  HistoryStatus,
  { label: string; icon: typeof CircleCheck; className: string }
> = {
  ok: { label: 'Succeeded', icon: CircleCheck, className: 'text-success' },
  error: { label: 'Failed', icon: CircleX, className: 'text-danger' },
  cancelled: { label: 'Cancelled', icon: Ban, className: 'text-muted' },
};

function firstLine(sql: string): string {
  return sql.trim().split('\n')[0] ?? '';
}

function when(startedAt: number): string {
  return new Date(startedAt).toLocaleString(undefined, {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
}

/**
 * Query history (REQ-HIST-01, REQ-HIST-02): search what ran, then insert it at the caret or open it
 * in a new console. Deleting entries and clearing a data source's history ask first.
 */
export function HistoryDialog({ onClose }: { onClose(): void }) {
  const connections = useConnections((s) => s.items);
  const activeTab = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const canInsert = isConsole(activeTab);
  const [connectionId, setConnectionId] = useState<string>(
    () => (isConsole(activeTab) ? activeTab.sourceId : null) ?? '',
  );
  const [text, setText] = useState('');
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Ignores answers to searches that were superseded while in flight.
  const generation = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  const names = useMemo(() => new Map(connections.map((c) => [c.id, c.name])), [connections]);
  const query = useMemo(
    () => ({ connectionId: connectionId || undefined, text, limit: HISTORY_PAGE, offset: 0 }),
    [connectionId, text],
  );

  async function load(offset: number) {
    const current = ++generation.current;
    setLoading(true);
    try {
      const page = await backend.historySearch({ ...query, offset });
      if (current !== generation.current) {
        return;
      }
      setEntries((previous) => (offset === 0 ? page : [...previous, ...page]));
      setHasMore(page.length === HISTORY_PAGE);
      if (offset === 0) {
        setSelected(0);
      }
      setError(null);
    } catch (e) {
      if (current === generation.current) {
        setError(`Could not load history: ${errorMessage(e)}`);
      }
    } finally {
      if (current === generation.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => void load(0), text ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the query changes
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${selected}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const entry = entries[selected];

  function insert(target: HistoryEntry | undefined) {
    const editor = activeEditor();
    if (!target || !canInsert || !editor) {
      return;
    }
    editor.insertText(target.sql);
    onClose();
  }

  async function openInConsole(target: HistoryEntry | undefined) {
    if (!target) {
      return;
    }
    const ws = useWorkspace.getState();
    const id = await ws.newConsole(target.connectionId);
    ws.updateText(id, target.sql);
    onClose();
  }

  async function remove(target: HistoryEntry | undefined) {
    if (!target) {
      return;
    }
    const ok = await askConfirm({
      title: 'Delete history entry',
      body: <p>Delete this statement from the query history? This cannot be undone.</p>,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) {
      return;
    }
    try {
      await backend.historyDelete([target.id]);
      setEntries((previous) => previous.filter((e) => e.id !== target.id));
      setSelected((index) => Math.max(0, Math.min(index, entries.length - 2)));
    } catch (e) {
      setError(`Could not delete the entry: ${errorMessage(e)}`);
    }
  }

  async function clear() {
    if (!connectionId) {
      return;
    }
    const name = names.get(connectionId) ?? connectionId;
    const ok = await askConfirm({
      title: 'Clear query history',
      body: (
        <p>
          Delete every recorded statement of <strong>{name}</strong>? This cannot be undone.
        </p>
      ),
      confirmLabel: 'Clear history',
      danger: true,
    });
    if (!ok) {
      return;
    }
    try {
      await backend.historyClear(connectionId);
      await load(0);
    } catch (e) {
      setError(`Could not clear the history: ${errorMessage(e)}`);
    }
  }

  async function exportAs(format: HistoryExportFormat) {
    try {
      const path = await backend.historyExport(query, format);
      if (path) {
        useNotifications.getState().notify(`Query history saved to ${path}`);
      }
    } catch (e) {
      setError(`Could not export the history: ${errorMessage(e)}`);
    }
  }

  function onSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((index) => Math.min(index + 1, entries.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((index) => Math.max(index - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (canInsert) {
        insert(entry);
      } else {
        void openInConsole(entry);
      }
    }
  }

  const button = 'rounded border border-border px-3 py-1 hover:bg-hover disabled:opacity-50';

  return (
    <Modal
      title="Query History"
      onClose={onClose}
      width={820}
      initialFocus="#history-search"
      footer={
        <>
          <button
            type="button"
            className={button}
            disabled={!entry}
            onClick={() => void remove(entry)}
          >
            Delete
          </button>
          <button
            type="button"
            className={button}
            disabled={!connectionId}
            title={connectionId ? undefined : 'Choose a data source first'}
            onClick={() => void clear()}
          >
            Clear data source history
          </button>
          <button type="button" className={button} onClick={() => void exportAs('csv')}>
            Export CSV
          </button>
          <button type="button" className={button} onClick={() => void exportAs('json')}>
            Export JSON
          </button>
          <div className="flex-1" />
          <button
            type="button"
            className={button}
            disabled={!entry}
            onClick={() => void openInConsole(entry)}
          >
            Open in new console
          </button>
          <button
            type="button"
            className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50"
            disabled={!entry || !canInsert}
            title={canInsert ? undefined : 'Open a console to insert into'}
            onClick={() => insert(entry)}
          >
            Insert
          </button>
        </>
      }
    >
      <div className="flex gap-2">
        <input
          id="history-search"
          type="search"
          aria-label="Search history"
          aria-controls="history-list"
          placeholder="Search statements (table names, keywords)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onSearchKeyDown}
          className="flex-1 rounded border border-border bg-bg px-2 py-1"
        />
        <select
          aria-label="Data source"
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          className="rounded border border-border bg-bg px-2 py-1"
        >
          <option value="">All data sources</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <ul
        id="history-list"
        ref={listRef}
        role="listbox"
        aria-label="History entries"
        aria-busy={loading}
        className="mt-2 h-64 overflow-auto rounded border border-border"
      >
        {entries.map((e, index) => {
          const status = STATUS[e.status];
          const Icon = status.icon;
          return (
            <li
              key={e.id}
              role="option"
              data-index={index}
              aria-selected={index === selected}
              onClick={() => setSelected(index)}
              onDoubleClick={() => (canInsert ? insert(e) : void openInConsole(e))}
              className={`flex cursor-default items-center gap-2 px-2 py-0.5 ${
                index === selected ? 'bg-selected' : 'hover:bg-hover'
              }`}
            >
              <Icon
                size={14}
                role="img"
                aria-label={status.label}
                className={`shrink-0 ${status.className}`}
              />
              <span className="flex-1 truncate font-mono">{firstLine(e.sql)}</span>
              <span className="shrink-0 text-muted">{names.get(e.connectionId) ?? ''}</span>
              <span className="w-16 shrink-0 text-right text-muted">{formatMs(e.durationMs)}</span>
              <span className="w-36 shrink-0 text-right text-muted">{when(e.startedAt)}</span>
            </li>
          );
        })}
        {!loading && entries.length === 0 && (
          <li className="px-2 py-1 text-muted">
            {text ? 'No statements match.' : 'Nothing recorded yet.'}
          </li>
        )}
        {hasMore && (
          <li>
            <button
              type="button"
              className="w-full px-2 py-1 text-left text-accent hover:bg-hover"
              onClick={() => void load(entries.length)}
            >
              Load more
            </button>
          </li>
        )}
      </ul>
      {entry && (
        <div className="mt-2" aria-label="Selected statement">
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-border bg-bg p-2 font-mono">
            {entry.sql}
          </pre>
          <p className="mt-1 text-muted">
            {STATUS[entry.status].label}
            {entry.rowCount !== null && ` · ${entry.rowCount} rows`}
            {` · ${entry.txMode === 'manual' ? 'manual transaction' : 'auto-commit'}`}
            {entry.console && ` · own session of ${entry.console}`}
          </p>
          {entry.error && <p className="mt-1 text-danger">{entry.error}</p>}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
