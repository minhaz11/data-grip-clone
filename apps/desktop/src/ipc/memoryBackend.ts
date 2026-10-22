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
  const consoles = new Map<string, string>();

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
    metadataChildren: () => fail('not_connected', 'This data source is not connected.'),
    objectDetails: () => fail('not_connected', 'This data source is not connected.'),
    ddlGenerate: () => fail('not_connected', 'This data source is not connected.'),
    tableModel: () => fail('not_connected', 'This data source is not connected.'),
    // Statements are built in Rust; the browser has no builder of its own.
    schemaPreview: () => fail('unsupported', 'Schema tools require the Quarry desktop app.'),
    schemaApply: () => fail('not_connected', 'This data source is not connected.'),
    ddlSave: () => fail('not_connected', 'This data source is not connected.'),
    queryExecute: () => fail('unsupported', 'Running queries requires the Quarry desktop app.'),
    queryCancel: async () => null,
    resultPage: () => fail('unsupported', 'Result paging requires the Quarry desktop app.'),
    resultClose: async () => null,
    resultPreviewEdits: () => fail('unsupported', 'Editing requires the Quarry desktop app.'),
    resultApplyEdits: () => fail('unsupported', 'Editing requires the Quarry desktop app.'),
    resultRefine: () =>
      fail('unsupported', 'Sorting and filtering require the Quarry desktop app.'),
    resultExport: () => fail('unsupported', 'Export requires the Quarry desktop app.'),
    resultCopy: () => fail('unsupported', 'Copy requires the Quarry desktop app.'),
    resultExportCancel: async () => null,
    resultFormat: () => fail('unsupported', 'Copy requires the Quarry desktop app.'),
    // No sessions exist in the browser: every session is closed and idle.
    sessionState: async (session) => ({
      session,
      open: false,
      status: 'idle',
      settings: { mode: 'auto', isolation: 'read_committed' },
    }),
    sessionSetTx: async (session, settings) => ({ session, open: false, status: 'idle', settings }),
    txCommit: () => fail('not_connected', 'This data source is not connected.'),
    txRollback: () => fail('not_connected', 'This data source is not connected.'),
    sessionClose: async () => null,
    sessionDrop: async () => null,
    appQuit: async () => null,
    onSessionState: async () => () => {},
    onQuitRequested: async () => () => {},
    consoleList: async () => [...consoles.keys()].sort(),
    consoleCreate: async (preferred) => {
      let name = preferred && !consoles.has(preferred) ? preferred : 'console';
      for (let i = 1; consoles.has(name); i++) name = `console_${i}`;
      consoles.set(name, '');
      return name;
    },
    consoleRead: async (name) =>
      consoles.get(name) ?? fail('not_found', `console "${name}" does not exist`),
    consoleWrite: async (name, text) => {
      if (!consoles.has(name)) return fail('not_found', `console "${name}" does not exist`);
      consoles.set(name, text);
      return null;
    },
    connectionDelete: async (id) => {
      if (!find(id)) return fail('not_found', 'data source not found');
      connections = connections.filter((c) => c.id !== id);
      return null;
    },
  };
}
