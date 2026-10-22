import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ConnectionDraft,
  ConnectionProfile,
  Cell,
  ColumnInfo,
  DdlObject,
  DdlOptions,
  ExecEvent,
  ExecRequest,
  ExportFormat,
  EditStatement,
  EditTarget,
  ExportSummary,
  RowChange,
  Refinement,
  StatementOutcome,
  MetaNode,
  MetadataRequest,
  ObjectDetails,
  ObjectRef,
  PasswordChange,
  QuitResolution,
  ServerInfo,
  SessionKey,
  SessionState,
  SessionStatus,
  Settings,
  StatusEvent,
  TxSettings,
  WorkspaceState,
} from './types';
import { createMemoryBackend } from './memoryBackend';

/** Every backend call the UI may make. The Tauri capability file allows exactly these commands. */
export interface Backend {
  settingsGet(): Promise<Settings>;
  settingsSet(settings: Settings): Promise<Settings>;
  workspaceGet(): Promise<WorkspaceState | null>;
  workspaceSet(state: WorkspaceState): Promise<null>;
  connectionsList(): Promise<ConnectionProfile[]>;
  connectionCreate(draft: ConnectionDraft, password: string | null): Promise<ConnectionProfile>;
  connectionUpdate(
    id: string,
    draft: ConnectionDraft,
    password: PasswordChange,
  ): Promise<ConnectionProfile>;
  connectionDuplicate(id: string): Promise<ConnectionProfile>;
  connectionDelete(id: string): Promise<null>;
  /** Tests a possibly unsaved draft; `id` reuses that profile's stored password. */
  connectionTest(
    draft: ConnectionDraft,
    id: string | null,
    password: string | null,
  ): Promise<ServerInfo>;
  connectionConnect(id: string, password: string | null): Promise<ServerInfo>;
  connectionDisconnect(id: string): Promise<null>;
  sessionsList(): Promise<SessionStatus[]>;
  /** Subscribes to session lifecycle events; resolves to an unsubscribe function. */
  onConnectionStatus(cb: (e: StatusEvent) => void): Promise<() => void>;
  /** One level of the explorer tree for a connected data source. */
  metadataChildren(id: string, request: MetadataRequest): Promise<MetaNode[]>;
  /** Everything the table viewer shows; `null` if the object no longer exists. */
  objectDetails(id: string, object: ObjectRef): Promise<ObjectDetails | null>;
  /** DDL for `objects`, as one script that applies in order. */
  ddlGenerate(id: string, objects: DdlObject[], options: DdlOptions): Promise<string>;
  /** Generates DDL and saves it via the native dialog; the saved path, or `null` if cancelled. */
  ddlSave(
    id: string,
    objects: DdlObject[],
    options: DdlOptions,
    fileName: string,
  ): Promise<string | null>;
  consoleList(): Promise<string[]>;
  /** Creates an empty console file; returns its name (`preferred` if free and valid). */
  consoleCreate(preferred: string | null): Promise<string>;
  consoleRead(name: string): Promise<string>;
  consoleWrite(name: string, text: string): Promise<null>;
  /** Starts a query job; resolves to its id at once. Progress arrives through `onEvent`. */
  queryExecute(request: ExecRequest, onEvent: (e: ExecEvent) => void): Promise<string>;
  queryCancel(jobId: string): Promise<null>;
  /** Rows `[offset, offset + limit)` of a result cursor (limit ≤ 2000). */
  resultPage(session: SessionKey, cursor: string, offset: number, limit: number): Promise<Cell[][]>;
  resultClose(session: SessionKey, cursor: string): Promise<null>;
  /** Re-runs `sql` with server-side sort/filter (in `schema`, as the run did); closes `previousCursor`. */
  resultRefine(
    session: SessionKey,
    sql: string,
    columns: ColumnInfo[],
    refinement: Refinement,
    previousCursor: string | null,
    schema: string | null,
  ): Promise<StatementOutcome>;
  resultPreviewEdits(
    session: SessionKey,
    target: EditTarget,
    changes: RowChange[],
  ): Promise<EditStatement[]>;
  /** All or nothing; resolves to the number of changes applied. */
  resultApplyEdits(session: SessionKey, target: EditTarget, changes: RowChange[]): Promise<number>;
  /** Native save dialog + streamed export in the backend; `null` if the user cancelled. */
  resultExport(
    session: SessionKey,
    cursor: string,
    columns: ColumnInfo[],
    format: ExportFormat,
    fileName: string,
    onProgress: (rows: number) => void,
  ): Promise<ExportSummary | null>;
  /** Transaction state and settings of a session (open or not). */
  sessionState(session: SessionKey): Promise<SessionState>;
  sessionSetTx(session: SessionKey, settings: TxSettings): Promise<SessionState>;
  txCommit(session: SessionKey): Promise<SessionState>;
  txRollback(session: SessionKey): Promise<SessionState>;
  /** Closes a console's own session. */
  sessionClose(session: SessionKey): Promise<null>;
  /** Drops a session's connection even while a statement runs (second-stage cancel). */
  sessionDrop(session: SessionKey): Promise<null>;
  /** Resolves every open transaction, then exits the app. */
  appQuit(resolution: QuitResolution): Promise<null>;
  onSessionState(cb: (e: SessionState) => void): Promise<() => void>;
  /** The window was closed while transactions are open; the UI decides and calls `appQuit`. */
  onQuitRequested(cb: (open: SessionKey[]) => void): Promise<() => void>;
}

const tauriBackend: Backend = {
  settingsGet: () => invoke<Settings>('settings_get'),
  settingsSet: (settings) => invoke<Settings>('settings_set', { settings }),
  workspaceGet: () => invoke<WorkspaceState | null>('workspace_get'),
  workspaceSet: (state) => invoke<null>('workspace_set', { state }),
  connectionsList: () => invoke<ConnectionProfile[]>('connections_list'),
  connectionCreate: (draft, password) =>
    invoke<ConnectionProfile>('connection_create', { draft, password }),
  connectionUpdate: (id, draft, password) =>
    invoke<ConnectionProfile>('connection_update', { id, draft, password }),
  connectionDuplicate: (id) => invoke<ConnectionProfile>('connection_duplicate', { id }),
  connectionDelete: (id) => invoke<null>('connection_delete', { id }),
  connectionTest: (draft, id, password) =>
    invoke<ServerInfo>('connection_test', { draft, id, password }),
  connectionConnect: (id, password) => invoke<ServerInfo>('connection_connect', { id, password }),
  connectionDisconnect: (id) => invoke<null>('connection_disconnect', { id }),
  sessionsList: () => invoke<SessionStatus[]>('sessions_list'),
  onConnectionStatus: (cb) => listen<StatusEvent>('connection-status', (e) => cb(e.payload)),
  metadataChildren: (id, request) => invoke<MetaNode[]>('metadata_children', { id, request }),
  objectDetails: (id, object) => invoke<ObjectDetails | null>('object_details', { id, object }),
  ddlGenerate: (id, objects, options) => invoke<string>('ddl_generate', { id, objects, options }),
  ddlSave: (id, objects, options, fileName) =>
    invoke<string | null>('ddl_save', { id, objects, options, fileName }),
  consoleList: () => invoke<string[]>('console_list'),
  consoleCreate: (preferred) => invoke<string>('console_create', { preferred }),
  consoleRead: (name) => invoke<string>('console_read', { name }),
  consoleWrite: (name, text) => invoke<null>('console_write', { name, text }),
  queryExecute: (request, onEvent) => {
    const channel = new Channel<ExecEvent>();
    channel.onmessage = onEvent;
    return invoke<string>('query_execute', { request, onEvent: channel });
  },
  queryCancel: (jobId) => invoke<null>('query_cancel', { jobId }),
  resultPage: (session, cursor, offset, limit) =>
    invoke<Cell[][]>('result_page', { session, cursor, offset, limit }),
  resultClose: (session, cursor) => invoke<null>('result_close', { session, cursor }),
  resultRefine: (session, sql, columns, refinement, previousCursor, schema) =>
    invoke<StatementOutcome>('result_refine', {
      session,
      sql,
      columns,
      refinement,
      previousCursor,
      schema,
    }),
  resultPreviewEdits: (session, target, changes) =>
    invoke<EditStatement[]>('result_preview_edits', { session, target, changes }),
  resultApplyEdits: (session, target, changes) =>
    invoke<number>('result_apply_edits', { session, target, changes }),
  resultExport: (session, cursor, columns, format, fileName, onProgress) => {
    const channel = new Channel<number>();
    channel.onmessage = onProgress;
    return invoke<ExportSummary | null>('result_export', {
      session,
      cursor,
      columns,
      format,
      fileName,
      onProgress: channel,
    });
  },
  sessionState: (session) => invoke<SessionState>('session_state', { session }),
  sessionSetTx: (session, settings) =>
    invoke<SessionState>('session_set_tx', { session, settings }),
  txCommit: (session) => invoke<SessionState>('tx_commit', { session }),
  txRollback: (session) => invoke<SessionState>('tx_rollback', { session }),
  sessionClose: (session) => invoke<null>('session_close', { session }),
  sessionDrop: (session) => invoke<null>('session_drop', { session }),
  appQuit: (resolution) => invoke<null>('app_quit', { resolution }),
  onSessionState: (cb) => listen<SessionState>('session-state', (e) => cb(e.payload)),
  onQuitRequested: (cb) => listen<SessionKey[]>('quit-requested', (e) => cb(e.payload)),
};

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Inside the desktop app we always talk to Rust. The in-memory backend exists only so the UI can run
 * in a plain browser (vite dev, Playwright, unit tests); it never ships behaviour of its own.
 */
export const backend: Backend = isTauri() ? tauriBackend : createMemoryBackend();
