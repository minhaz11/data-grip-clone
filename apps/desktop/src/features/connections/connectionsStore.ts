import { create } from 'zustand';
import { backend } from '../../ipc/client';
import type {
  ConnectionDraft,
  ConnectionProfile,
  Folder,
  PasswordChange,
  SshProfile,
  SshProfileDraft,
} from '../../ipc/types';
import { errorMessage } from '../../app/settingsStore';

interface ConnectionsState {
  items: ConnectionProfile[];
  folders: Folder[];
  sshProfiles: SshProfile[];
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
  rename(id: string, name: string): Promise<ConnectionProfile>;
  /** Moves a data source into `folderId` (`null` = top level) at `index` among its siblings. */
  move(id: string, folderId: string | null, index: number): Promise<void>;
  createFolder(name: string, color: string | null): Promise<Folder>;
  updateFolder(folderId: string, name: string, color: string | null): Promise<Folder>;
  removeFolder(folderId: string): Promise<void>;
  createSshProfile(draft: SshProfileDraft, secret: string | null): Promise<SshProfile>;
  updateSshProfile(
    profileId: string,
    draft: SshProfileDraft,
    secret: PasswordChange,
  ): Promise<SshProfile>;
  removeSshProfile(profileId: string): Promise<void>;
}

function rethrow(e: unknown): never {
  throw new Error(errorMessage(e));
}

export const useConnections = create<ConnectionsState>((set, get) => {
  async function refresh(selectedId = get().selectedId) {
    const [items, folders, sshProfiles] = await Promise.all([
      backend.connectionsList(),
      backend.foldersList(),
      backend.sshProfilesList(),
    ]);
    set({ items, folders, sshProfiles, selectedId, error: null });
  }

  return {
    items: [],
    folders: [],
    sshProfiles: [],
    selectedId: null,
    loading: false,
    error: null,
    async load() {
      set({ loading: true });
      try {
        await refresh();
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
    async rename(id, name) {
      const p = await backend.connectionRename(id, name).catch(rethrow);
      await refresh();
      return p;
    },
    async move(id, folderId, index) {
      await backend.connectionMove(id, folderId, index).catch(rethrow);
      await refresh();
    },
    async createFolder(name, color) {
      const folder = await backend.folderCreate(name, color).catch(rethrow);
      await refresh();
      return folder;
    },
    async updateFolder(folderId, name, color) {
      const folder = await backend.folderUpdate(folderId, name, color).catch(rethrow);
      // Data sources inherit the folder's color: reload them too.
      await refresh();
      return folder;
    },
    async removeFolder(folderId) {
      await backend.folderDelete(folderId).catch(rethrow);
      await refresh();
    },
    async createSshProfile(draft, secret) {
      const profile = await backend.sshProfileCreate(draft, secret).catch(rethrow);
      await refresh();
      return profile;
    },
    async updateSshProfile(profileId, draft, secret) {
      const profile = await backend.sshProfileUpdate(profileId, draft, secret).catch(rethrow);
      await refresh();
      return profile;
    },
    async removeSshProfile(profileId) {
      await backend.sshProfileDelete(profileId).catch(rethrow);
      await refresh();
    },
  };
});
