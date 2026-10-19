import { create } from 'zustand';
import type { WorkspaceState } from '../ipc/types';

export interface ConsoleTab {
  id: string;
  title: string;
  text: string;
}

interface WorkspaceStore {
  tabs: ConsoleTab[];
  activeTabId: string | null;
  explorerCollapsed: boolean;
  bottomCollapsed: boolean;
  layout: Record<string, Record<string, number>>;
  caret: { line: number; column: number } | null;
  hydrated: boolean;

  hydrate(state: WorkspaceState | null): void;
  newConsole(): string;
  closeTab(id: string): void;
  activate(id: string): void;
  cycleTab(delta: 1 | -1): void;
  updateText(id: string, text: string): void;
  setCaret(caret: { line: number; column: number } | null): void;
  setLayout(groupId: string, layout: Record<string, number>): void;
  setExplorerCollapsed(collapsed: boolean): void;
  setBottomCollapsed(collapsed: boolean): void;
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `console-${Date.now().toString(36)}-${idCounter}`;
}

/** Picks the lowest free "console", "console_1", ... title, the same scheme used for console files. */
export function nextConsoleTitle(existing: string[]): string {
  if (!existing.includes('console')) return 'console';
  for (let i = 1; ; i++) if (!existing.includes(`console_${i}`)) return `console_${i}`;
}

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  tabs: [],
  activeTabId: null,
  explorerCollapsed: false,
  bottomCollapsed: false,
  layout: {},
  caret: null,
  hydrated: false,

  hydrate(state) {
    if (!state) return set({ hydrated: true });
    const activeTabId = state.tabs.some((t) => t.id === state.activeTabId)
      ? state.activeTabId
      : (state.tabs[0]?.id ?? null);
    set({
      tabs: state.tabs,
      activeTabId,
      explorerCollapsed: state.panels.explorerCollapsed,
      bottomCollapsed: state.panels.bottomCollapsed,
      layout: state.layout,
      hydrated: true,
    });
  },
  newConsole() {
    const id = newId();
    const title = nextConsoleTitle(get().tabs.map((t) => t.title));
    set((s) => ({ tabs: [...s.tabs, { id, title, text: '' }], activeTabId: id, caret: null }));
    return id;
  },
  closeTab(id) {
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      if (index < 0) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (activeTabId === id) activeTabId = (tabs[index] ?? tabs[index - 1])?.id ?? null;
      return { tabs, activeTabId, caret: activeTabId === s.activeTabId ? s.caret : null };
    });
  },
  activate(id) {
    if (get().activeTabId !== id && get().tabs.some((t) => t.id === id))
      set({ activeTabId: id, caret: null });
  },
  cycleTab(delta) {
    const { tabs, activeTabId } = get();
    if (tabs.length === 0) return;
    const index = tabs.findIndex((t) => t.id === activeTabId);
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next && next.id !== activeTabId) set({ activeTabId: next.id, caret: null });
  },
  updateText(id, text) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, text } : t)) }));
  },
  setCaret: (caret) => set({ caret }),
  setLayout: (groupId, layout) => set((s) => ({ layout: { ...s.layout, [groupId]: layout } })),
  setExplorerCollapsed: (explorerCollapsed) => set({ explorerCollapsed }),
  setBottomCollapsed: (bottomCollapsed) => set({ bottomCollapsed }),
}));

export function snapshot(s: WorkspaceStore): WorkspaceState {
  return {
    layout: s.layout,
    panels: { explorerCollapsed: s.explorerCollapsed, bottomCollapsed: s.bottomCollapsed },
    tabs: s.tabs,
    activeTabId: s.activeTabId,
  };
}
