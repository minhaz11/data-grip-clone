import { create } from 'zustand';
import { backend } from '../../ipc/client';
import type { MetadataRequest } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { isWithin, type Loaded } from './treeModel';

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
      set((s) => ({ children: { ...s.children, [key]: result } }));
    },
    refresh: (key) => {
      drop(key, false);
      // Refreshing a whole data source makes its tree current again.
      if (get().stale[key]) set((s) => ({ stale: { ...s.stale, [key]: undefined } }));
    },
    resetSource: (sourceId) => {
      drop(sourceId, true);
      set((s) => ({ stale: { ...s.stale, [sourceId]: undefined } }));
    },
    stale: {},
    markStale: (sourceId) => set((s) => ({ stale: { ...s.stale, [sourceId]: true } })),
  };
});
