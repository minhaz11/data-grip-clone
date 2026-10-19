/** Mirrors `quarry_store::Settings` (crates/store). Keep in sync until bindings are generated. */
export type ThemePreference = 'system' | 'light' | 'dark';

export interface Settings {
  theme: ThemePreference;
  editorFontSize: number;
}

export const DEFAULT_SETTINGS: Settings = { theme: 'system', editorFontSize: 13 };

/** Persisted workbench state restored on startup. */
export interface WorkspaceState {
  layout: Record<string, Record<string, number>>;
  panels: { explorerCollapsed: boolean; bottomCollapsed: boolean };
  tabs: { id: string; title: string; text: string }[];
  activeTabId: string | null;
}

export interface AppError {
  kind: string;
  message: string;
}
