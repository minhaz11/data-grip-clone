/**
 * IPC types. Everything that crosses IPC is generated from the Rust types into `bindings.ts`
 * (regenerate with `npm run bindings`); this file re-exports it and adds the few types the UI owns.
 */
import type { Settings } from './bindings';

export type * from './bindings';

export const DEFAULT_SETTINGS: Settings = { theme: 'system', editorFontSize: 13 };

/** Text form of a value as the server renders it; `null` is SQL NULL (Rust `quarry_db_core::Cell`). */
export type Cell = string | null;

// ---- Workspace state: the backend stores it as an opaque JSON blob, so the UI owns its shape ----

/** An open console tab as persisted; its text lives in the console's `.sql` file. */
export interface ConsoleTabState {
  id: string;
  /** Console file name (without `.sql`). */
  console: string;
  /** Data source the console runs against, if bound. */
  sourceId: string | null;
  /** Runs in its own session (own transaction) instead of the data source's shared one. */
  ownSession?: boolean;
  /** Schema put first in the search path for this console's runs; absent = server default. */
  schema?: string | null;
}

/** Pre-M3.1 tabs kept their text inline; migrated into console files on load. */
export interface LegacyTabState {
  id: string;
  title: string;
  text: string;
}

/** Persisted workbench state restored on startup. */
export interface WorkspaceState {
  layout: Record<string, Record<string, number>>;
  panels: { explorerCollapsed: boolean; bottomCollapsed: boolean };
  tabs: (ConsoleTabState | LegacyTabState)[];
  activeTabId: string | null;
}
