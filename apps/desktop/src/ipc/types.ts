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

export type ConnectErrorKind =
  | 'dns'
  | 'refused'
  | 'timeout'
  | 'auth'
  | 'password_required'
  | 'database_missing'
  | 'tls'
  | 'server_unavailable'
  | 'other';

/** Error shape of every rejected backend call. */
export interface AppError {
  kind: string;
  message: string;
  hint?: string;
  sqlstate?: string;
  connectKind?: ConnectErrorKind;
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

// ---- Connectivity (mirrors quarry_db_core / sessions.rs) ----

export interface ServerInfo {
  version: string;
  serverVersion: string;
  database: string;
  user: string;
  tls: boolean;
  readOnly: boolean;
  latencyMs: number;
}

export interface SessionStatus {
  id: string;
  info: ServerInfo;
}

export type StatusEvent =
  | { state: 'connected'; id: string; info: ServerInfo }
  | { state: 'disconnected'; id: string }
  | { state: 'lost'; id: string; reason: string };
