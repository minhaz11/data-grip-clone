import type { Backend } from './client';
import {
  DEFAULT_SETTINGS,
  type ConnectionDraft,
  type ConnectionProfile,
  type Settings,
  type WorkspaceState,
} from './types';

/**
 * Non-persistent backend for browser-only runs and tests. It mirrors the Rust contract (unique
 * names, password-saved flag) but never holds a password: the flag is all the UI can observe.
 */
export function createMemoryBackend(): Backend {
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let workspace: WorkspaceState | null = null;
  let connections: ConnectionProfile[] = [];
  let seq = 0;

  const fail = (kind: string, message: string) => Promise.reject({ kind, message });
  const nameTaken = (name: string, exceptId?: string) =>
    connections.some(
      (c) => c.id !== exceptId && c.name.toLowerCase() === name.trim().toLowerCase(),
    );
  const find = (id: string) => connections.find((c) => c.id === id);
  const now = () => new Date().toISOString();
  const sorted = () =>
    [...connections].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );

  function insert(draft: ConnectionDraft, passwordSaved: boolean): ConnectionProfile {
    seq += 1;
    const profile = {
      ...draft,
      name: draft.name.trim(),
      id: `mem-${seq}`,
      passwordSaved,
      createdAt: now(),
      updatedAt: now(),
    };
    connections.push(profile);
    return profile;
  }

  return {
    settingsGet: async () => settings,
    settingsSet: async (next) => (settings = { ...next }),
    workspaceGet: async () => workspace,
    workspaceSet: async (next) => {
      workspace = structuredClone(next);
      return null;
    },
    connectionsList: async () => sorted(),
    connectionCreate: async (draft, password) => {
      if (nameTaken(draft.name))
        return fail('invalid', `A data source named "${draft.name.trim()}" already exists.`);
      if (draft.saveMode === 'never' && password !== null)
        return fail('invalid', 'A password cannot be saved when "Save password" is set to Never.');
      return insert(draft, password !== null);
    },
    connectionUpdate: async (id, draft, change) => {
      const current = find(id);
      if (!current) return fail('not_found', 'data source not found');
      if (nameTaken(draft.name, id))
        return fail('invalid', `A data source named "${draft.name.trim()}" already exists.`);
      let passwordSaved = current.passwordSaved;
      if (change.action === 'set') passwordSaved = true;
      if (change.action === 'clear' || draft.saveMode === 'never') passwordSaved = false;
      const updated = {
        ...current,
        ...draft,
        name: draft.name.trim(),
        passwordSaved,
        updatedAt: now(),
      };
      connections = connections.map((c) => (c.id === id ? updated : c));
      return updated;
    },
    connectionDuplicate: async (id) => {
      const source = find(id);
      if (!source) return fail('not_found', 'data source not found');
      let name = `${source.name} (copy)`;
      for (let n = 2; nameTaken(name); n++) name = `${source.name} (copy ${n})`;
      const { id: _id, passwordSaved, createdAt: _c, updatedAt: _u, ...draft } = source;
      return insert({ ...draft, name }, passwordSaved);
    },
    // A browser cannot open database sockets; say so instead of pretending to connect.
    connectionTest: () =>
      fail('unsupported', 'Connecting to databases requires the Quarry desktop app.'),
    connectionConnect: () =>
      fail('unsupported', 'Connecting to databases requires the Quarry desktop app.'),
    connectionDisconnect: async () => null,
    sessionsList: async () => [],
    onConnectionStatus: async () => () => {},
    connectionDelete: async (id) => {
      if (!find(id)) return fail('not_found', 'data source not found');
      connections = connections.filter((c) => c.id !== id);
      return null;
    },
  };
}
