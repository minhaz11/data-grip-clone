import type { Backend } from './client';
import { DEFAULT_SETTINGS, type Settings, type WorkspaceState } from './types';

/** Non-persistent backend for browser-only runs and tests. */
export function createMemoryBackend(): Backend {
  let settings: Settings = { ...DEFAULT_SETTINGS };
  let workspace: WorkspaceState | null = null;
  return {
    settingsGet: async () => settings,
    settingsSet: async (next) => (settings = { ...next }),
    workspaceGet: async () => workspace,
    workspaceSet: async (next) => {
      workspace = structuredClone(next);
      return null;
    },
  };
}
