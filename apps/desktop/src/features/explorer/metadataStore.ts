import { create } from 'zustand';
import { backend } from '../../ipc/client';
import type { MetadataRequest } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { childKey, isWithin, type Loaded } from './treeModel';

interface MetadataState {
  children: Record<string, Loaded | undefined>;
  expanded: Record<string, boolean | undefined>;
  setExpanded(key: string, open: boolean): void;
  /** Loads one level unless it is already loaded or loading. */
  load(key: string, sourceId: string, request: MetadataRequest): Promise<void>;
  /** Drops cached children at and below `key`; expanded levels reload as they become visible. */
  refresh(key: string): void;
  /** Forgets everything about a data source (disconnect, lost session, delete). */
  resetSource(sourceId: string): void;
  /** Data sources whose tree may be out of date (DDL ran in a console). */
  stale: Record<string, boolean | undefined>;
  markStale(sourceId: string): void;
  /** How many schemas each connected data source has, ignoring its schema scope (`null` while
   * loading or when it could not be read). */
  schemaTotals: Record<string, number | null | undefined>;
  /** Reads a data source's schema total once per session. */
  loadSchemaTotal(sourceId: string): Promise<void>;
  /** A node the explorer should expand its way to and select (tree keys from the source down). */
  reveal: { sourceId: string; path: string[] } | null;
  requestReveal(sourceId: string, path: string[]): void;
  clearReveal(): void;
  /** When each data source's top level was last loaded (epoch ms). */
  refreshedAt: Record<string, number | undefined>;
  /** Stops waiting for a level; asks the server to cancel the query when it safely can. */
  cancelLoad(key: string, sourceId: string): Promise<void>;
  /** Collapses every node, plus `also` (folders, which are open unless collapsed). */
  collapseAll(also?: string[]): void;
  /** Expands `root` and every loaded node below it that has children. */
  expandLoaded(root: string): void;
}

// Bumped per key on refresh/reset so late responses for discarded requests are ignored.
const generation = new Map<string, number>();

export const useMetadata = create<MetadataState>((set, get) => {
  const without = <T>(record: Record<string, T>, root: string) =>
    Object.fromEntries(Object.entries(record).filter(([k]) => !isWithin(k, root)));

  const drop = (root: string, includeExpanded: boolean) =>
    set((s) => {
      for (const k of Object.keys(s.children)) {
        if (isWithin(k, root)) generation.set(k, (generation.get(k) ?? 0) + 1);
      }
      return {
        children: without(s.children, root),
        expanded: includeExpanded ? without(s.expanded, root) : s.expanded,
      };
    });

  return {
    children: {},
    expanded: {},
    setExpanded: (key, open) => set((s) => ({ expanded: { ...s.expanded, [key]: open } })),
    async load(key, sourceId, request) {
      if (get().children[key]) return;
      const gen = generation.get(key) ?? 0;
      set((s) => ({ children: { ...s.children, [key]: { status: 'loading' } } }));
      let result: Loaded;
      try {
        result = { status: 'loaded', nodes: await backend.metadataChildren(sourceId, request) };
      } catch (e) {
        result = { status: 'error', error: toAppError(e) };
      }
      if ((generation.get(key) ?? 0) !== gen) return; // refreshed or reset meanwhile
      set((s) => ({
        children: { ...s.children, [key]: result },
        refreshedAt:
          key === sourceId && result.status === 'loaded'
            ? { ...s.refreshedAt, [sourceId]: Date.now() }
            : s.refreshedAt,
      }));
    },
    refresh: (key) => {
      drop(key, false);
      // Refreshing a whole data source makes its tree current again.
      if (get().stale[key]) set((s) => ({ stale: { ...s.stale, [key]: undefined } }));
    },
    resetSource: (sourceId) => {
      drop(sourceId, true);
      set((s) => ({
        stale: { ...s.stale, [sourceId]: undefined },
        schemaTotals: { ...s.schemaTotals, [sourceId]: undefined },
      }));
    },
    schemaTotals: {},
    async loadSchemaTotal(sourceId) {
      if (get().schemaTotals[sourceId] !== undefined) {
        return;
      }
      set((s) => ({ schemaTotals: { ...s.schemaTotals, [sourceId]: null } }));
      try {
        const all = await backend.metadataChildren(sourceId, { level: 'allSchemas' });
        set((s) => ({ schemaTotals: { ...s.schemaTotals, [sourceId]: all.length } }));
      } catch {
        // Leave it unknown: the label then says only that a scope is set.
      }
    },
    stale: {},
    markStale: (sourceId) => set((s) => ({ stale: { ...s.stale, [sourceId]: true } })),
    refreshedAt: {},
    async cancelLoad(key, sourceId) {
      if (get().children[key]?.status !== 'loading') {
        return;
      }
      // The pending response is ignored from now on.
      generation.set(key, (generation.get(key) ?? 0) + 1);
      set((s) => ({
        children: {
          ...s.children,
          [key]: {
            status: 'error',
            error: { kind: 'cancelled', message: 'Loading cancelled.' },
          },
        },
      }));
      await backend.metadataCancel(sourceId).catch(() => false);
    },
    collapseAll: (also = []) =>
      set((s) => ({
        expanded: Object.fromEntries([...Object.keys(s.expanded), ...also].map((k) => [k, false])),
      })),
    expandLoaded(root) {
      const { children } = get();
      const open: Record<string, boolean> = { [root]: true };
      const walk = (key: string) => {
        const loaded = children[key];
        if (loaded?.status !== 'loaded') {
          return;
        }
        for (const node of loaded.nodes) {
          if (node.children) {
            const child = childKey(key, node);
            open[child] = true;
            walk(child);
          }
        }
      };
      walk(root);
      set((s) => ({ expanded: { ...s.expanded, ...open } }));
    },
    reveal: null,
    requestReveal: (sourceId, path) => set({ reveal: { sourceId, path } }),
    clearReveal: () => set({ reveal: null }),
  };
});
