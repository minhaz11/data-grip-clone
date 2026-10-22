import { useWorkspace } from './workspaceStore';
import { useConnections } from '../features/connections/connectionsStore';
import { effectiveColor } from '../features/connections/model';
import { useSessions, type SessionState } from '../features/connections/sessionsStore';
import { keyOf, sessionOf, useTx } from '../features/exec/txStore';

function sessionText(s: SessionState | undefined): string {
  switch (s?.state) {
    case 'connected':
      return `connected · PostgreSQL ${s.info.serverVersion}`;
    case 'connecting':
      return 'connecting…';
    case 'lost':
      return 'connection lost';
    case 'failed':
      return 'connection failed';
    default:
      return 'not connected';
  }
}

export function StatusBar({ theme }: { theme: 'light' | 'dark' }) {
  const caret = useWorkspace((s) => s.caret);
  const hasActiveTab = useWorkspace((s) => s.activeTabId !== null);
  const selected = useConnections((s) => s.items.find((c) => c.id === s.selectedId));
  const session = useSessions((s) => (selected ? s.byId[selected.id] : undefined));
  const color = selected ? effectiveColor(selected) : null;
  const activeTab = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const txSession = activeTab ? sessionOf(activeTab) : null;
  const tx = useTx((s) => (txSession ? s.states[keyOf(txSession)] : undefined));

  return (
    <footer
      aria-label="Status bar"
      className="flex h-6 shrink-0 items-center gap-4 border-t border-border bg-panel px-3 text-[11px] text-muted"
    >
      {selected ? (
        <span className="flex items-center gap-1.5" aria-label="Selected data source">
          {color && (
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: color }}
              aria-hidden
            />
          )}
          {selected.name}
          {selected.readOnly && <span> (read-only)</span>}
          <span> · {sessionText(session)}</span>
        </span>
      ) : (
        <span>No data source selected</span>
      )}
      {tx?.open && (
        <span aria-label="Transaction state">
          {tx.status === 'active'
            ? 'Transaction open'
            : tx.status === 'failed'
              ? 'Transaction failed'
              : tx.settings.mode === 'manual'
                ? 'Manual commit'
                : 'Auto-commit'}
          {activeTab?.ownSession ? ' · own session' : ''}
        </span>
      )}
      <div className="flex-1" />
      {hasActiveTab && caret && (
        <span aria-label="Cursor position">
          Ln {caret.line}, Col {caret.column}
        </span>
      )}
      <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
    </footer>
  );
}
