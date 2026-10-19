import { useWorkspace } from './workspaceStore';
import { useConnections } from '../features/connections/connectionsStore';
import { effectiveColor } from '../features/connections/model';

export function StatusBar({ theme }: { theme: 'light' | 'dark' }) {
  const caret = useWorkspace((s) => s.caret);
  const hasActiveTab = useWorkspace((s) => s.activeTabId !== null);
  const selected = useConnections((s) => s.items.find((c) => c.id === s.selectedId));
  const color = selected ? effectiveColor(selected) : null;

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
        </span>
      ) : (
        <span>No data source selected</span>
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
