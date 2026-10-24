import { create } from 'zustand';
import { errorMessage } from '../../app/settingsStore';
import { backend } from '../../ipc/client';
import { DEFAULT_AI_SETTINGS, type AiSettings, type AiStatus } from '../../ipc/types';

interface AiState {
  /** What Rust reports; `active` is the kill switch as enforced there. */
  status: AiStatus;
  load(): Promise<void>;
  /** Mutations reject with a user-facing `Error`. */
  saveSettings(settings: AiSettings): Promise<void>;
  setKey(key: string): Promise<void>;
  clearKey(): Promise<void>;
}

const OFF: AiStatus = {
  settings: DEFAULT_AI_SETTINGS,
  keyStored: false,
  workspaceId: 'main',
  active: false,
};

function rethrow(e: unknown): never {
  throw new Error(errorMessage(e));
}

export const useAi = create<AiState>((set) => ({
  status: OFF,
  async load() {
    try {
      set({ status: await backend.aiSettingsGet() });
    } catch {
      // Without a readable status, AI stays off.
      set({ status: OFF });
    }
  },
  async saveSettings(settings) {
    set({ status: await backend.aiSettingsSet(settings).catch(rethrow) });
  },
  async setKey(key) {
    set({ status: await backend.aiKeySet(key).catch(rethrow) });
  },
  async clearKey() {
    set({ status: await backend.aiKeyClear().catch(rethrow) });
  },
}));

/** Whether AI entry points should be shown: on, not off for this workspace, and a key stored. */
export const aiAvailable = (s: AiStatus = useAi.getState().status) => s.active && s.keyStored;
