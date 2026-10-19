import { useEffect } from 'react';
import { Group, Panel, Separator, usePanelRef, type Layout } from 'react-resizable-panels';
import { ExplorerPanel } from '../features/explorer/ExplorerPanel';
import { EditorArea } from '../features/editor/EditorArea';
import { BottomPanel } from '../features/results/BottomPanel';
import { useWorkspace } from './workspaceStore';
import type { ConnectionProfile } from '../ipc/types';

const MAIN = 'main';
const CENTER = 'center';

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
  onNewConnection(): void;
  onEditConnection(profile: ConnectionProfile): void;
}

export function Workbench({ onNewConnection, onEditConnection }: Props) {
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
        <ExplorerPanel onNew={onNewConnection} onEdit={onEditConnection} />
      </Panel>
      <Separator className="w-px" />
      <Panel id="center" minSize="30">
        <Group
          id={CENTER}
          orientation="vertical"
          defaultLayout={layout[CENTER]}
          onLayoutChanged={saveLayout(CENTER)}
        >
          <Panel id="editor" minSize="20">
            <EditorArea />
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
            <BottomPanel />
          </Panel>
        </Group>
      </Panel>
    </Group>
  );
}
