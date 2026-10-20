import { useMemo, useState } from 'react';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { Workbench } from './Workbench';
import { useAppliedTheme, useKeybindings, useWorkspacePersistence } from './hooks';
import { useWorkspace } from './workspaceStore';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { useConnections } from '../features/connections/connectionsStore';
import { activeEditor } from '../features/editor/editorHandle';
import { ConnectionDialog } from '../features/connections/ConnectionDialog';
import type { ConnectionProfile } from '../ipc/types';

export function App() {
  const { ready, error } = useWorkspacePersistence();
  const theme = useAppliedTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const notices = useWorkspace((s) => s.notices);
  const dismissNotices = useWorkspace((s) => s.dismissNotices);
  // `null` = closed, `'new'` = create, profile = edit.
  const [connectionDialog, setConnectionDialog] = useState<ConnectionProfile | 'new' | null>(null);

  const handlers = useMemo(() => {
    const ws = () => useWorkspace.getState();
    return {
      'console.new': () => void ws().newConsole(useConnections.getState().selectedId),
      'tab.close': () => {
        const id = ws().activeTabId;
        if (id) void ws().closeTab(id);
      },
      'tab.next': () => ws().cycleTab(1),
      'tab.previous': () => ws().cycleTab(-1),
      'view.toggleExplorer': () => ws().setExplorerCollapsed(!ws().explorerCollapsed),
      'view.toggleBottomPanel': () => ws().setBottomCollapsed(!ws().bottomCollapsed),
      'settings.open': () => setSettingsOpen(true),
      'datasource.new': () => setConnectionDialog('new'),
      'editor.format': () => activeEditor()?.format(),
    };
  }, []);
  useKeybindings(handlers);

  if (!ready) {
    return (
      <div role="status" className="flex h-full items-center justify-center text-muted">
        Loading workspace…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Toolbar onOpenSettings={() => setSettingsOpen(true)} />
      {error && (
        <div role="alert" className="border-b border-border bg-panel-2 px-3 py-1 text-danger">
          {error}
        </div>
      )}
      {notices.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-border bg-panel-2 px-3 py-1 text-danger"
        >
          <span className="flex-1">{notices.join(' ')}</span>
          <button type="button" className="text-muted underline" onClick={dismissNotices}>
            Dismiss
          </button>
        </div>
      )}
      <Workbench
        theme={theme}
        onNewConnection={() => setConnectionDialog('new')}
        onEditConnection={setConnectionDialog}
      />
      <StatusBar theme={theme} />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {connectionDialog && (
        <ConnectionDialog
          profile={connectionDialog === 'new' ? undefined : connectionDialog}
          onClose={() => setConnectionDialog(null)}
        />
      )}
    </div>
  );
}
