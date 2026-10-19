import { useWorkspace } from './workspaceStore';

export function StatusBar({ theme }: { theme: 'light' | 'dark' }) {
  const caret = useWorkspace((s) => s.caret);
  const hasActiveTab = useWorkspace((s) => s.activeTabId !== null);

  return (
    <footer
      aria-label="Status bar"
      className="flex h-6 shrink-0 items-center gap-4 border-t border-border bg-panel px-3 text-[11px] text-muted"
    >
      <span>No data source</span>
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
