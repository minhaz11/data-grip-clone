import { create } from 'zustand';
import { backend } from '../ipc/client';
import { DEFAULT_SETTINGS, type Settings, type ThemePreference } from '../ipc/types';

interface SettingsState {
  settings: Settings;
  loaded: boolean;
  error: string | null;
  load(): Promise<void>;
  update(patch: Partial<Settings>): Promise<void>;
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  error: null,
  async load() {
    try {
      set({ settings: await backend.settingsGet(), loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: errorMessage(e) });
    }
  },
  async update(patch) {
    const previous = get().settings;
    const next = { ...previous, ...patch };
    set({ settings: next }); // optimistic; reverted below if the backend rejects it
    try {
      set({ settings: await backend.settingsSet(next), error: null });
    } catch (e) {
      set({ settings: previous, error: errorMessage(e) });
    }
  },
}));

export function resolveTheme(pref: ThemePreference, prefersDark: boolean): 'light' | 'dark' {
  return pref === 'system' ? (prefersDark ? 'dark' : 'light') : pref;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e)
    return String((e as { message: unknown }).message);
  return String(e);
}
