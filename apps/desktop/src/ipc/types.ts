/**
 * IPC types. Everything that crosses IPC is generated from the Rust types into `bindings.ts`
 * (regenerate with `npm run bindings`); this file re-exports it and adds the few types the UI owns.
 */
import type { DdlObject, ImportFormat, ObjectRef, Settings } from './bindings';

export type * from './bindings';

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  editorFontSize: 13,
  resultTabs: 'reuse',
  statementTimeoutSecs: 0,
  longQuerySecs: 20,
  runOutsideStatement: 'nearest',
  runSelection: 'all',
  historyLimit: 10_000,
  historyMaxAgeDays: 0,
  revisionLimit: 100,
  revisionMaxAgeDays: 30,
  revisionIntervalMins: 5,
  keymap: {},
};

/** Text form of a value as the server renders it; `null` is SQL NULL (Rust `quarry_db_core::Cell`). */
export type Cell = string | null;

// ---- Workspace state: the backend stores it as an opaque JSON blob, so the UI owns its shape ----

/** An open console tab as persisted; its text lives in the console's `.sql` file. */
export interface ConsoleTabState {
  id: string;
  kind?: 'console';
  /** Kept first and by Close others / Close all. */
  pinned?: boolean;
  /** Console file name (without `.sql`). */
  console: string;
  /** Data source the console runs against, if bound. */
  sourceId: string | null;
  /** Runs in its own session (own transaction) instead of the data source's shared one. */
  ownSession?: boolean;
  /** Schema put first in the search path for this console's runs; absent = server default. */
  schema?: string | null;
  /** Column order and visibility of this tab's results, by column signature (M4.8). */
  gridLayouts?: Record<string, GridLayout>;
  /** Last values given for statement parameters (`:name`, `$1`), by name (M4.7). */
  params?: Record<string, string | null>;
}

/** Column order and visibility of a result: result-column indices. */
export interface GridLayout {
  /** Display order; columns not listed follow in result order. */
  order: number[];
  hidden: number[];
}

/** A read-only structure view of one table, view or materialized view (M4.3). */
export interface ObjectTabState {
  id: string;
  kind: 'object';
  pinned?: boolean;
  sourceId: string;
  object: ObjectRef;
}

/** Generated DDL for some objects (M4.4); the text is generated again when the tab is shown. */
export interface DdlTabState {
  id: string;
  kind: 'ddl';
  pinned?: boolean;
  sourceId: string;
  objects: DdlObject[];
  /** What the DDL is for, e.g. `shop.orders`. */
  title: string;
}

/** A table's rows ("Open data", M4.8), filtered and sorted with free-form SQL text. */
export interface DataTabState {
  id: string;
  kind: 'data';
  pinned?: boolean;
  sourceId: string;
  object: ObjectRef;
  /** Condition after WHERE, as typed; empty for all rows. */
  where?: string;
  /** Expression list after ORDER BY, as typed. */
  orderBy?: string;
  gridLayouts?: Record<string, GridLayout>;
}

/** Pre-M3.1 tabs kept their text inline; migrated into console files on load. */
export interface LegacyTabState {
  id: string;
  title: string;
  text: string;
}

/** A named set of file format options for imports. */
export interface ImportPreset {
  name: string;
  format: ImportFormat;
}

/** Persisted workbench state restored on startup. */
export interface WorkspaceState {
  layout: Record<string, Record<string, number>>;
  panels: { explorerCollapsed: boolean; bottomCollapsed: boolean };
  tabs: (ConsoleTabState | LegacyTabState | ObjectTabState | DdlTabState | DataTabState)[];
  activeTabId: string | null;
  importPresets?: ImportPreset[];
}
