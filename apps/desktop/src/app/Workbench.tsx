import { useEffect } from 'react';
import { Group, Panel, Separator, usePanelRef, type Layout } from 'react-resizable-panels';
import { ExplorerPanel } from '../features/explorer/ExplorerPanel';
import { EditorArea } from '../features/editor/EditorArea';
import { BottomPanel } from '../features/results/BottomPanel';
import { AssistantPanel } from '../features/ai/AssistantPanel';
import { useAssistant } from '../features/ai/assistantStore';
import { isConsole, useWorkspace } from './workspaceStore';
import type { ConnectionProfile } from '../ipc/types';
import { activeEditor } from '../features/editor/editorHandle';

/** Moves focus to the editor: the active console's text, or the active tab. */
export function focusEditor(): boolean {
  const ws = useWorkspace.getState();
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
  if (!tab) {
    return false;
  }
  const editor = isConsole(tab) ? activeEditor() : null;
  if (editor) {
    editor.focus();
    return true;
  }
  const el = document.getElementById(`tab-${tab.id}`);
  el?.focus();
  return el !== null;
}

/** Escape in a side panel returns to the editor, unless something inside used the key. */
function escapeToEditor(e: React.KeyboardEvent) {
  if (
    e.key !== 'Escape' ||
    e.defaultPrevented ||
    e.shiftKey ||
    e.ctrlKey ||
    e.altKey ||
    e.metaKey
  ) {
    return;
  }
  if (
    e.target instanceof Element &&
    e.target.closest('[role="menu"], [role="dialog"], [role="listbox"]')
  ) {
    return;
  }
  if (focusEditor()) {
    e.preventDefault();
  }
}

const MAIN = 'main';
const CENTER = 'center';
const WORK = 'work';

/** Keeps a collapsible panel in sync with a boolean in the store, in both directions. */
function useCollapsible(collapsed: boolean, setCollapsed: (c: boolean) => void) {
  const ref = usePanelRef();
  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    if (collapsed && !panel.isCollapsed()) panel.collapse();
    if (!collapsed && panel.isCollapsed()) panel.expand();
  }, [collapsed, ref]);
  const onResize = () => {
    const isCollapsed = ref.current?.isCollapsed() ?? false;
    if (isCollapsed !== collapsed) setCollapsed(isCollapsed);
  };
  return { ref, onResize };
}

interface Props {
  theme: 'light' | 'dark';
  onNewConnection(): void;
  onEditConnection(profile: ConnectionProfile): void;
}

export function Workbench({ theme, onNewConnection, onEditConnection }: Props) {
  const layout = useWorkspace((s) => s.layout);
  const setLayout = useWorkspace((s) => s.setLayout);
  const explorer = useCollapsible(
    useWorkspace((s) => s.explorerCollapsed),
    useWorkspace((s) => s.setExplorerCollapsed),
  );
  const bottom = useCollapsible(
    useWorkspace((s) => s.bottomCollapsed),
    useWorkspace((s) => s.setBottomCollapsed),
  );
  // Rendered only while open (a collapsed panel stays inert); its width is not kept.
  const assistantOpen = useAssistant((s) => s.open);

  const saveLayout = (id: string) => (next: Layout) => setLayout(id, next);

  return (
    <Group
      id={MAIN}
      orientation="horizontal"
      defaultLayout={layout[MAIN]}
      onLayoutChanged={saveLayout(MAIN)}
      className="min-h-0 flex-1"
    >
      <Panel
        id="explorer"
        defaultSize="22"
        minSize="12"
        maxSize="50"
        collapsible
        panelRef={explorer.ref}
        onResize={explorer.onResize}
      >
        <div className="h-full" onKeyDown={escapeToEditor}>
          <ExplorerPanel onNew={onNewConnection} onEdit={onEditConnection} />
        </div>
      </Panel>
      <Separator className="w-px" />
      <Panel id="center" minSize="30">
        <Group id={WORK} orientation="horizontal">
          <Panel id="work-main" minSize="40">
            <Group
              id={CENTER}
              orientation="vertical"
              defaultLayout={layout[CENTER]}
              onLayoutChanged={saveLayout(CENTER)}
            >
              <Panel id="editor" minSize="20">
                <EditorArea theme={theme} />
              </Panel>
              <Separator className="h-px" />
              <Panel
                id="bottom"
                defaultSize="32"
                minSize="10"
                collapsible
                panelRef={bottom.ref}
                onResize={bottom.onResize}
              >
                <div className="h-full" onKeyDown={escapeToEditor}>
                  <BottomPanel />
                </div>
              </Panel>
            </Group>
          </Panel>
          {assistantOpen && (
            <>
              <Separator className="w-px" />
              <Panel id="assistant" defaultSize="28" minSize="18" maxSize="50">
                <div className="h-full" onKeyDown={escapeToEditor}>
                  <AssistantPanel />
                </div>
              </Panel>
            </>
          )}
        </Group>
      </Panel>
    </Group>
  );
}
