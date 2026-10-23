import { History, PanelBottom, PanelLeft, Settings, SquarePlus } from 'lucide-react';
import { IconButton } from '../components/ui/IconButton';
import { useKeymap } from './keymapStore';
import { shortcutLabel } from '../lib/keymap';
import { useWorkspace } from './workspaceStore';

export function Toolbar({
  onOpenSettings,
  onOpenHistory,
}: {
  onOpenSettings(): void;
  onOpenHistory(): void;
}) {
  const explorerCollapsed = useWorkspace((s) => s.explorerCollapsed);
  const bottomCollapsed = useWorkspace((s) => s.bottomCollapsed);
  const setExplorerCollapsed = useWorkspace((s) => s.setExplorerCollapsed);
  const setBottomCollapsed = useWorkspace((s) => s.setBottomCollapsed);
  const newConsole = useWorkspace((s) => s.newConsole);
  const keymap = useKeymap();

  return (
    <div
      role="toolbar"
      aria-label="Main toolbar"
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-panel px-2"
    >
      <span className="mr-2 font-semibold tracking-tight">Quarry</span>
      <IconButton
        label="Database Explorer"
        shortcut={shortcutLabel('view.toggleExplorer', keymap)}
        pressed={!explorerCollapsed}
        onClick={() => setExplorerCollapsed(!explorerCollapsed)}
      >
        <PanelLeft size={16} aria-hidden />
      </IconButton>
      <IconButton
        label="New console"
        shortcut={shortcutLabel('console.new', keymap)}
        onClick={() => newConsole()}
      >
        <SquarePlus size={16} aria-hidden />
      </IconButton>
      <IconButton
        label="Query history"
        shortcut={shortcutLabel('history.open', keymap)}
        onClick={onOpenHistory}
      >
        <History size={16} aria-hidden />
      </IconButton>
      <div className="flex-1" />
      <IconButton
        label="Results panel"
        shortcut={shortcutLabel('view.toggleBottomPanel', keymap)}
        pressed={!bottomCollapsed}
        onClick={() => setBottomCollapsed(!bottomCollapsed)}
      >
        <PanelBottom size={16} aria-hidden />
      </IconButton>
      <IconButton
        label="Settings"
        shortcut={shortcutLabel('settings.open', keymap)}
        onClick={onOpenSettings}
      >
        <Settings size={16} aria-hidden />
      </IconButton>
    </div>
  );
}
