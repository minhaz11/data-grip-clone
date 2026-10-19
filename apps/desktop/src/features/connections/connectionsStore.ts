import { create } from 'zustand';
import { backend } from '../../ipc/client';
import type { ConnectionDraft, ConnectionProfile, PasswordChange } from '../../ipc/types';
import { errorMessage } from '../../app/settingsStore';

interface ConnectionsState {
  items: ConnectionProfile[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  load(): Promise<void>;
  select(id: string | null): void;
  /** Mutations reject with a user-facing `Error` so dialogs can show it inline. */
  create(draft: ConnectionDraft, password: string | null): Promise<ConnectionProfile>;
  update(id: string, draft: ConnectionDraft, password: PasswordChange): Promise<ConnectionProfile>;
  duplicate(id: string): Promise<ConnectionProfile>;
  remove(id: string): Promise<void>;
}

function rethrow(e: unknown): never {
  throw new Error(errorMessage(e));
}

export const useConnections = create<ConnectionsState>((set, get) => {
  async function refresh(selectedId: string | null) {
    set({ items: await backend.connectionsList(), selectedId, error: null });
  }

  return {
    items: [],
    selectedId: null,
    loading: false,
    error: null,
    async load() {
      set({ loading: true });
      try {
        set({ items: await backend.connectionsList(), error: null });
      } catch (e) {
        set({ error: `Could not load data sources: ${errorMessage(e)}` });
      } finally {
        set({ loading: false });
      }
    },
    select: (selectedId) => set({ selectedId }),
    async create(draft, password) {
      const p = await backend.connectionCreate(draft, password).catch(rethrow);
      await refresh(p.id);
      return p;
    },
    async update(id, draft, password) {
      const p = await backend.connectionUpdate(id, draft, password).catch(rethrow);
      await refresh(p.id);
      return p;
    },
    async duplicate(id) {
      const p = await backend.connectionDuplicate(id).catch(rethrow);
      await refresh(p.id);
      return p;
    },
    async remove(id) {
      await backend.connectionDelete(id).catch(rethrow);
      const items = get().items;
      const index = items.findIndex((c) => c.id === id);
      const neighbour = items[index + 1] ?? items[index - 1];
      await refresh(neighbour ? neighbour.id : null);
    },
  };
});
