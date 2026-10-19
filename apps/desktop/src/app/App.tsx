import { useMemo, useState } from 'react';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { Workbench } from './Workbench';
import { useAppliedTheme, useKeybindings, useWorkspacePersistence } from './hooks';
import { useWorkspace } from './workspaceStore';
import { SettingsDialog } from '../features/settings/SettingsDialog';

export function App() {
  const { ready, error } = useWorkspacePersistence();
  const theme = useAppliedTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const handlers = useMemo(() => {
    const ws = () => useWorkspace.getState();
    return {
      'console.new': () => ws().newConsole(),
      'tab.close': () => {
        const id = ws().activeTabId;
        if (id) ws().closeTab(id);
      },
      'tab.next': () => ws().cycleTab(1),
      'tab.previous': () => ws().cycleTab(-1),
      'view.toggleExplorer': () => ws().setExplorerCollapsed(!ws().explorerCollapsed),
      'view.toggleBottomPanel': () => ws().setBottomCollapsed(!ws().bottomCollapsed),
      'settings.open': () => setSettingsOpen(true),
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
      <Workbench />
      <StatusBar theme={theme} />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
