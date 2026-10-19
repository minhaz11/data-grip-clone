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

// ---- Connections (mirrors quarry_store::connections) ----

export type Engine = 'postgresql';
export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';
export type Environment = 'none' | 'development' | 'testing' | 'staging' | 'production';
export type SaveMode = 'never' | 'untilRestart' | 'forever';

export interface ConnectionDraft {
  name: string;
  engine: Engine;
  host: string;
  port: number;
  database: string;
  username: string;
  sslMode: SslMode;
  connectTimeoutSecs: number;
  readOnly: boolean;
  environment: Environment;
  color: string | null;
  saveMode: SaveMode;
}

/** A stored profile. There is deliberately no password field: secrets never come back over IPC. */
export interface ConnectionProfile extends ConnectionDraft {
  id: string;
  passwordSaved: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PasswordChange =
  { action: 'keep' } | { action: 'clear' } | { action: 'set'; value: string };
