import { create } from 'zustand';
import { backend } from '../ipc/client';
import type {
  ConsoleTabState,
  DataTabState,
  DdlObject,
  DdlTabState,
  GridLayout,
  ObjectRef,
  ObjectTabState,
  WorkspaceState,
} from '../ipc/types';
import { toAppError } from '../lib/errors';

export type SaveState = 'saved' | 'pending' | 'saving' | 'error';

export interface ConsoleTab extends ConsoleTabState {
  text: string;
  save: SaveState;
  saveError?: string;
}

export type ObjectTab = ObjectTabState;
export type DdlTab = DdlTabState;
export type DataTab = DataTabState;

/** An editor tab: a SQL console, an object (table viewer), generated DDL or a table's data. */
export type EditorTab = ConsoleTab | ObjectTab | DdlTab | DataTab;

export function isConsole(tab: EditorTab | undefined): tab is ConsoleTab {
  return !!tab && tab.kind !== 'object' && tab.kind !== 'ddl' && tab.kind !== 'data';
}

/** Tabs that show result grids, and so keep column layouts. */
export type GridTab = ConsoleTab | DataTab;

/** Parameter values remembered per console. */
export const MAX_PARAMS = 50;

/** Column layouts kept per tab; the oldest go first. */
export const MAX_GRID_LAYOUTS = 20;

function sameObject(a: ObjectRef, b: ObjectRef): boolean {
  return a.schema === b.schema && a.name === b.name && a.objectType === b.objectType;
}

interface WorkspaceStore {
  tabs: EditorTab[];
  activeTabId: string | null;
  explorerCollapsed: boolean;
  bottomCollapsed: boolean;
  layout: Record<string, Record<string, number>>;
  caret: { line: number; column: number } | null;
  hydrated: boolean;
  /** Problems met while restoring (missing console files, migration failures). */
  notices: string[];

  hydrate(state: WorkspaceState | null): Promise<void>;
  newConsole(sourceId?: string | null): Promise<string>;
  /** Opens (or activates) the table viewer for `object`. */
  openObject(sourceId: string, object: ObjectRef): string;
  /** Opens (or activates) a DDL tab for `objects`. */
  openDdl(sourceId: string, objects: DdlObject[], title: string): string;
  /** Opens (or activates) the data of a table or view. */
  openData(sourceId: string, object: ObjectRef): string;
  /** The WHERE and ORDER BY text of a data tab. */
  setDataFilter(id: string, where: string, orderBy: string): void;
  /** Stores (or with `null` forgets) a result's column layout in its tab. */
  setGridLayout(id: string, signature: string, layout: GridLayout | null): void;
  closeTab(id: string): Promise<void>;
  activate(id: string): void;
  cycleTab(delta: 1 | -1): void;
  updateText(id: string, text: string): void;
  setSource(id: string, sourceId: string | null): void;
  setOwnSession(id: string, own: boolean): void;
  setSchema(id: string, schema: string | null): void;
  /** Remembers parameter values given for a console's statements. */
  setParams(id: string, values: Record<string, string | null>): void;
  /** Writes every unsaved console now (tab close, app hide). */
  flushAll(): Promise<void>;
  setCaret(caret: { line: number; column: number } | null): void;
  setLayout(groupId: string, layout: Record<string, number>): void;
  setExplorerCollapsed(collapsed: boolean): void;
  setBottomCollapsed(collapsed: boolean): void;
  dismissNotices(): void;
}

export const AUTOSAVE_MS = 400;

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `tab-${Date.now().toString(36)}-${idCounter}`;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
// Hydration may be requested twice (React StrictMode); legacy migration must run only once.
let hydration: Promise<void> | null = null;

/** Test hook: allow a fresh hydration. */
export function resetHydrationForTests() {
  hydration = null;
}

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  // Only consoles carry text, save state and session settings.
  const patchTab = (id: string, patch: Partial<ConsoleTab>) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id && isConsole(t) ? { ...t, ...patch } : t)),
    }));

  async function saveNow(id: string) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    const tab = get().tabs.find((t) => t.id === id);
    if (!isConsole(tab) || tab.save === 'saved') return;
    const text = tab.text;
    patchTab(id, { save: 'saving' });
    try {
      await backend.consoleWrite(tab.console, text);
      // Edited again while writing? Stay pending; the newer text has its own timer.
      const now = get().tabs.find((t) => t.id === id);
      if (isConsole(now))
        patchTab(
          id,
          now.text === text ? { save: 'saved', saveError: undefined } : { save: 'pending' },
        );
    } catch (e) {
      patchTab(id, { save: 'error', saveError: toAppError(e).message });
    }
  }

  async function restore(state: WorkspaceState | null) {
    if (!state) return set({ hydrated: true });
    const tabs: EditorTab[] = [];
    const notices: string[] = [];
    for (const t of state.tabs) {
      try {
        if ('kind' in t && (t.kind === 'object' || t.kind === 'ddl' || t.kind === 'data')) {
          tabs.push(t);
        } else if ('console' in t) {
          tabs.push({ ...t, text: await backend.consoleRead(t.console), save: 'saved' });
        } else {
          // Legacy inline text: move it into a console file so nothing typed before is lost.
          const name = await backend.consoleCreate(t.title);
          await backend.consoleWrite(name, t.text);
          tabs.push({ id: t.id, console: name, sourceId: null, text: t.text, save: 'saved' });
        }
      } catch (e) {
        const label = 'object' in t ? t.object.name : 'console' in t ? t.console : t.title;
        notices.push(`Could not reopen console "${label}": ${toAppError(e).message}`);
      }
    }
    const activeTabId = tabs.some((t) => t.id === state.activeTabId)
      ? state.activeTabId
      : (tabs[0]?.id ?? null);
    set({
      tabs,
      activeTabId,
      notices,
      explorerCollapsed: state.panels.explorerCollapsed,
      bottomCollapsed: state.panels.bottomCollapsed,
      layout: state.layout,
      hydrated: true,
    });
  }

  return {
    tabs: [],
    activeTabId: null,
    explorerCollapsed: false,
    bottomCollapsed: false,
    layout: {},
    caret: null,
    hydrated: false,
    notices: [],

    hydrate(state) {
      hydration ??= restore(state);
      return hydration;
    },

    async newConsole(sourceId = null) {
      const name = await backend.consoleCreate(null);
      const id = newId();
      set((s) => ({
        tabs: [...s.tabs, { id, console: name, sourceId, text: '', save: 'saved' }],
        activeTabId: id,
        caret: null,
      }));
      return id;
    },

    async closeTab(id) {
      await saveNow(id);
      set((s) => {
        const index = s.tabs.findIndex((t) => t.id === id);
        if (index < 0) return s;
        const tabs = s.tabs.filter((t) => t.id !== id);
        let activeTabId = s.activeTabId;
        if (activeTabId === id) activeTabId = (tabs[index] ?? tabs[index - 1])?.id ?? null;
        return { tabs, activeTabId, caret: activeTabId === s.activeTabId ? s.caret : null };
      });
    },

    openObject(sourceId, object) {
      const existing = get().tabs.find(
        (t) => t.kind === 'object' && t.sourceId === sourceId && sameObject(t.object, object),
      );
      if (existing) {
        set({ activeTabId: existing.id, caret: null });
        return existing.id;
      }
      const id = newId();
      set((s) => ({
        tabs: [...s.tabs, { id, kind: 'object', sourceId, object }],
        activeTabId: id,
        caret: null,
      }));
      return id;
    },

    openDdl(sourceId, objects, title) {
      const key = JSON.stringify(objects);
      const existing = get().tabs.find(
        (t) => t.kind === 'ddl' && t.sourceId === sourceId && JSON.stringify(t.objects) === key,
      );
      if (existing) {
        set({ activeTabId: existing.id, caret: null });
        return existing.id;
      }
      const id = newId();
      set((s) => ({
        tabs: [...s.tabs, { id, kind: 'ddl', sourceId, objects, title }],
        activeTabId: id,
        caret: null,
      }));
      return id;
    },

    openData(sourceId, object) {
      const existing = get().tabs.find(
        (t) => t.kind === 'data' && t.sourceId === sourceId && sameObject(t.object, object),
      );
      if (existing) {
        set({ activeTabId: existing.id, caret: null });
        return existing.id;
      }
      const id = newId();
      set((s) => ({
        tabs: [...s.tabs, { id, kind: 'data', sourceId, object }],
        activeTabId: id,
        caret: null,
      }));
      return id;
    },

    setDataFilter(id, where, orderBy) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === id && t.kind === 'data' ? { ...t, where, orderBy } : t)),
      }));
    },

    setGridLayout(id, signature, layout) {
      set((s) => ({
        tabs: s.tabs.map((t) => {
          if (t.id !== id || !(isConsole(t) || t.kind === 'data')) {
            return t;
          }
          const rest = Object.entries(t.gridLayouts ?? {}).filter(([k]) => k !== signature);
          const kept = layout ? [...rest, [signature, layout] as const] : rest;
          return { ...t, gridLayouts: Object.fromEntries(kept.slice(-MAX_GRID_LAYOUTS)) };
        }),
      }));
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
      const tab = get().tabs.find((t) => t.id === id);
      if (!isConsole(tab) || tab.text === text) return;
      patchTab(id, { text, save: 'pending' });
      clearTimeout(timers.get(id));
      timers.set(
        id,
        setTimeout(() => void saveNow(id), AUTOSAVE_MS),
      );
    },

    // A different data source has different schemas.
    setSource: (id, sourceId) => patchTab(id, { sourceId, schema: null }),
    setOwnSession: (id, ownSession) => patchTab(id, { ownSession }),
    setSchema: (id, schema) => patchTab(id, { schema }),
    setParams(id, values) {
      const tab = get().tabs.find((t) => t.id === id);
      if (isConsole(tab)) {
        // Newest last; a console keeps a bounded number of names.
        const kept = Object.entries(tab.params ?? {}).filter(([name]) => !(name in values));
        const merged = [...kept, ...Object.entries(values)].slice(-MAX_PARAMS);
        patchTab(id, { params: Object.fromEntries(merged) });
      }
    },

    async flushAll() {
      await Promise.all(
        get()
          .tabs.filter((t) => isConsole(t) && t.save !== 'saved')
          .map((t) => saveNow(t.id)),
      );
    },

    setCaret: (caret) => set({ caret }),
    setLayout: (groupId, layout) => set((s) => ({ layout: { ...s.layout, [groupId]: layout } })),
    setExplorerCollapsed: (explorerCollapsed) => set({ explorerCollapsed }),
    setBottomCollapsed: (bottomCollapsed) => set({ bottomCollapsed }),
    dismissNotices: () => set({ notices: [] }),
  };
});

/** Picks the lowest free "console", "console_1", ... title (mirrors the backend's naming). */
export function nextConsoleTitle(existing: string[]): string {
  if (!existing.includes('console')) return 'console';
  for (let i = 1; ; i++) if (!existing.includes(`console_${i}`)) return `console_${i}`;
}

/** What is persisted: tab identity and binding, never console text (that lives in files). */
export function snapshot(
  s: Pick<
    WorkspaceStore,
    'layout' | 'explorerCollapsed' | 'bottomCollapsed' | 'tabs' | 'activeTabId'
  >,
): WorkspaceState {
  return {
    layout: s.layout,
    panels: { explorerCollapsed: s.explorerCollapsed, bottomCollapsed: s.bottomCollapsed },
    tabs: s.tabs.map((t) =>
      isConsole(t)
        ? {
            id: t.id,
            console: t.console,
            sourceId: t.sourceId,
            ...(t.ownSession ? { ownSession: t.ownSession } : {}),
            ...(t.schema ? { schema: t.schema } : {}),
            ...layouts(t),
            ...(t.params && Object.keys(t.params).length > 0 ? { params: t.params } : {}),
          }
        : t.kind === 'object'
          ? { id: t.id, kind: 'object' as const, sourceId: t.sourceId, object: t.object }
          : t.kind === 'data'
            ? {
                id: t.id,
                kind: 'data' as const,
                sourceId: t.sourceId,
                object: t.object,
                ...(t.where ? { where: t.where } : {}),
                ...(t.orderBy ? { orderBy: t.orderBy } : {}),
                ...layouts(t),
              }
            : {
                id: t.id,
                kind: 'ddl' as const,
                sourceId: t.sourceId,
                objects: t.objects,
                title: t.title,
              },
    ),
    activeTabId: s.activeTabId,
  };
}

function layouts(t: GridTab): { gridLayouts?: Record<string, GridLayout> } {
  return t.gridLayouts && Object.keys(t.gridLayouts).length > 0
    ? { gridLayouts: t.gridLayouts }
    : {};
}
