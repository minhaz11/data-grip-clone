import type { Backend } from './client';
import {
  DEFAULT_SETTINGS,
  type ConnectionDraft,
  type ConnectionProfile,
  type Folder,
  type Settings,
  type SshProfile,
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
  let folders: Folder[] = [];
  let sshProfiles: SshProfile[] = [];
  let seq = 0;
  const consoles = new Map<string, string>();

  const fail = (kind: string, message: string) => Promise.reject({ kind, message });
  const nameTaken = (name: string, exceptId?: string) =>
    connections.some(
      (c) => c.id !== exceptId && c.name.toLowerCase() === name.trim().toLowerCase(),
    );
  const find = (id: string) => connections.find((c) => c.id === id);
  const now = () => new Date().toISOString();
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  // Same order as app.db: top level first, then by folder, position, name.
  const sorted = () =>
    [...connections].sort(
      (a, b) =>
        Number(a.folderId !== null) - Number(b.folderId !== null) ||
        (a.folderId ?? '').localeCompare(b.folderId ?? '') ||
        a.sortOrder - b.sortOrder ||
        byName(a, b),
    );
  const inFolder = (folderId: string | null, exceptId?: string) =>
    sorted().filter((c) => c.folderId === folderId && c.id !== exceptId);

  function insert(draft: ConnectionDraft, passwordSaved: boolean): ConnectionProfile {
    seq += 1;
    const siblings = inFolder(draft.folderId);
    const profile = {
      ...draft,
      name: draft.name.trim(),
      id: `mem-${seq}`,
      passwordSaved,
      sortOrder: siblings.length ? Math.max(...siblings.map((c) => c.sortOrder)) + 1 : 0,
      createdAt: now(),
      updatedAt: now(),
    };
    connections.push(profile);
    return profile;
  }

  const folderTaken = (name: string, exceptId?: string) =>
    folders.some((f) => f.id !== exceptId && f.name.toLowerCase() === name.trim().toLowerCase());
  const sshTaken = (name: string, exceptId?: string) =>
    sshProfiles.some(
      (p) => p.id !== exceptId && p.name.toLowerCase() === name.trim().toLowerCase(),
    );

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
      if (nameTaken(draft.name)) {
        return fail('invalid', `A data source named "${draft.name.trim()}" already exists.`);
      }
      if (draft.saveMode === 'never' && password !== null) {
        return fail('invalid', 'A password cannot be saved when "Save password" is set to Never.');
      }
      return insert(draft, password !== null);
    },
    connectionUpdate: async (id, draft, change) => {
      const current = find(id);
      if (!current) {
        return fail('not_found', 'data source not found');
      }
      if (nameTaken(draft.name, id)) {
        return fail('invalid', `A data source named "${draft.name.trim()}" already exists.`);
      }
      let passwordSaved = current.passwordSaved;
      if (change.action === 'set') {
        passwordSaved = true;
      }
      if (change.action === 'clear' || draft.saveMode === 'never') {
        passwordSaved = false;
      }
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
      if (!source) {
        return fail('not_found', 'data source not found');
      }
      let name = `${source.name} (copy)`;
      for (let n = 2; nameTaken(name); n++) {
        name = `${source.name} (copy ${n})`;
      }
      const {
        id: _id,
        passwordSaved,
        sortOrder: _s,
        createdAt: _c,
        updatedAt: _u,
        ...draft
      } = source;
      return insert({ ...draft, name }, passwordSaved);
    },
    connectionRename: async (id, name) => {
      const current = find(id);
      if (!current) {
        return fail('not_found', 'data source not found');
      }
      if (!name.trim()) {
        return fail('invalid', 'Name is required.');
      }
      if (nameTaken(name, id)) {
        return fail('invalid', `A data source named "${name.trim()}" already exists.`);
      }
      const updated = { ...current, name: name.trim(), updatedAt: now() };
      connections = connections.map((c) => (c.id === id ? updated : c));
      return updated;
    },
    connectionMove: async (id, folderId, index) => {
      const current = find(id);
      if (!current) {
        return fail('not_found', 'data source not found');
      }
      if (folderId !== null && !folders.some((f) => f.id === folderId)) {
        return fail('not_found', `folder ${folderId}`);
      }
      const siblings = inFolder(folderId, id);
      siblings.splice(Math.min(index, siblings.length), 0, current);
      const order = new Map(siblings.map((c, i) => [c.id, i]));
      connections = connections.map((c) =>
        order.has(c.id) ? { ...c, folderId, sortOrder: order.get(c.id) ?? 0 } : c,
      );
      return null;
    },
    connectionSchemas: () =>
      fail('unsupported', 'Listing schemas requires the Quarry desktop app.'),
    foldersList: async () => [...folders].sort((a, b) => a.sortOrder - b.sortOrder || byName(a, b)),
    folderCreate: async (name, color) => {
      if (!name.trim()) {
        return fail('invalid', 'Folder name is required.');
      }
      if (folderTaken(name)) {
        return fail('invalid', `A folder named "${name.trim()}" already exists.`);
      }
      seq += 1;
      const folder = {
        id: `folder-${seq}`,
        name: name.trim(),
        color,
        sortOrder: folders.length,
      };
      folders.push(folder);
      return folder;
    },
    folderUpdate: async (folderId, name, color) => {
      const current = folders.find((f) => f.id === folderId);
      if (!current) {
        return fail('not_found', `folder ${folderId}`);
      }
      if (!name.trim()) {
        return fail('invalid', 'Folder name is required.');
      }
      if (folderTaken(name, folderId)) {
        return fail('invalid', `A folder named "${name.trim()}" already exists.`);
      }
      const updated = { ...current, name: name.trim(), color };
      folders = folders.map((f) => (f.id === folderId ? updated : f));
      return updated;
    },
    folderDelete: async (folderId) => {
      if (!folders.some((f) => f.id === folderId)) {
        return fail('not_found', `folder ${folderId}`);
      }
      const after = inFolder(null).length;
      connections = connections.map((c) =>
        c.folderId === folderId ? { ...c, folderId: null, sortOrder: after + c.sortOrder } : c,
      );
      folders = folders.filter((f) => f.id !== folderId);
      return null;
    },
    sshProfilesList: async () => [...sshProfiles].sort(byName),
    sshProfileCreate: async (draft, secret) => {
      if (sshTaken(draft.name)) {
        return fail('invalid', `An SSH profile named "${draft.name.trim()}" already exists.`);
      }
      seq += 1;
      const profile: SshProfile = {
        ...draft,
        name: draft.name.trim(),
        keyFile: draft.auth === 'key' ? draft.keyFile : null,
        id: `ssh-${seq}`,
        secretSaved: secret !== null && draft.saveMode !== 'never' && draft.auth !== 'agent',
        createdAt: now(),
        updatedAt: now(),
      };
      sshProfiles.push(profile);
      return profile;
    },
    sshProfileUpdate: async (profileId, draft, change) => {
      const current = sshProfiles.find((p) => p.id === profileId);
      if (!current) {
        return fail('not_found', 'SSH profile not found');
      }
      if (sshTaken(draft.name, profileId)) {
        return fail('invalid', `An SSH profile named "${draft.name.trim()}" already exists.`);
      }
      const sameSecret = current.auth === draft.auth && current.keyFile === draft.keyFile;
      let secretSaved = sameSecret && current.secretSaved;
      if (change.action === 'set') {
        secretSaved = true;
      }
      if (change.action === 'clear' || draft.saveMode === 'never' || draft.auth === 'agent') {
        secretSaved = false;
      }
      const updated = {
        ...current,
        ...draft,
        name: draft.name.trim(),
        keyFile: draft.auth === 'key' ? draft.keyFile : null,
        secretSaved,
        updatedAt: now(),
      };
      sshProfiles = sshProfiles.map((p) => (p.id === profileId ? updated : p));
      return updated;
    },
    sshProfileDelete: async (profileId) => {
      const users = connections.filter((c) => c.sshProfileId === profileId).map((c) => c.name);
      if (users.length) {
        return fail(
          'invalid',
          `This SSH profile is used by ${users.join(', ')}. Choose another tunnel for them first.`,
        );
      }
      sshProfiles = sshProfiles.filter((p) => p.id !== profileId);
      return null;
    },
    sshHostTrust: () => fail('unsupported', 'SSH tunnels require the Quarry desktop app.'),
    filePick: () => fail('unsupported', 'Choosing files requires the Quarry desktop app.'),
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
    // Nothing runs in the browser, so nothing is ever recorded.
    historySearch: async () => [],
    historyDelete: async () => 0,
    historyClear: async () => 0,
    historyExport: () => fail('unsupported', 'Exporting history requires the Quarry desktop app.'),
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
      for (let i = 1; consoles.has(name); i++) {
        name = `console_${i}`;
      }
      consoles.set(name, '');
      return name;
    },
    consoleRead: async (name) =>
      consoles.get(name) ?? fail('not_found', `console "${name}" does not exist`),
    consoleRename: async (name, newName) => {
      if (!consoles.has(name)) {
        return fail('not_found', `console "${name}" does not exist`);
      }
      if (name !== newName && consoles.has(newName)) {
        return fail('invalid', `a console named "${newName}" already exists`);
      }
      const text = consoles.get(name) ?? '';
      consoles.delete(name);
      consoles.set(newName, text);
      return null;
    },
    consoleDuplicate: async (name) => {
      const text = consoles.get(name);
      if (text === undefined) {
        return fail('not_found', `console "${name}" does not exist`);
      }
      let copy = `${name} copy`;
      for (let n = 2; consoles.has(copy); n++) {
        copy = `${name} copy ${n}`;
      }
      consoles.set(copy, text);
      return copy;
    },
    consoleDelete: async (name) => {
      if (!consoles.delete(name)) {
        return fail('not_found', `console "${name}" does not exist`);
      }
      return null;
    },
    consolesDir: async () => '(browser memory)',
    metadataCancel: async () => false,
    consoleWrite: async (name, text) => {
      if (!consoles.has(name)) {
        return fail('not_found', `console "${name}" does not exist`);
      }
      consoles.set(name, text);
      return null;
    },
    connectionDelete: async (id) => {
      if (!find(id)) {
        return fail('not_found', 'data source not found');
      }
      connections = connections.filter((c) => c.id !== id);
      return null;
    },
  };
}
