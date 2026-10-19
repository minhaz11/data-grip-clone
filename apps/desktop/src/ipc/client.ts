import { invoke } from '@tauri-apps/api/core';
import type { Settings, WorkspaceState } from './types';
import { createMemoryBackend } from './memoryBackend';

/** Every backend call the UI may make. The Tauri capability file allows exactly these commands. */
export interface Backend {
  settingsGet(): Promise<Settings>;
  settingsSet(settings: Settings): Promise<Settings>;
  workspaceGet(): Promise<WorkspaceState | null>;
  workspaceSet(state: WorkspaceState): Promise<null>;
}

const tauriBackend: Backend = {
  settingsGet: () => invoke<Settings>('settings_get'),
  settingsSet: (settings) => invoke<Settings>('settings_set', { settings }),
  workspaceGet: () => invoke<WorkspaceState | null>('workspace_get'),
  workspaceSet: (state) => invoke<null>('workspace_set', { state }),
};

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Inside the desktop app we always talk to Rust. The in-memory backend exists only so the UI can run
 * in a plain browser (vite dev, Playwright, unit tests); it never ships behaviour of its own.
 */
export const backend: Backend = isTauri() ? tauriBackend : createMemoryBackend();
