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
  CopySummary,
  ExportFormat,
  ExportOptions,
  EditStatement,
  EditTarget,
  DroppedFile,
  ExportSummary,
  FilePurpose,
  ImportEvent,
  ImportFile,
  ImportFormat,
  ImportPlan,
  ImportPreview,
  Folder,
  HistoryEntry,
  HistoryExportFormat,
  HistoryQuery,
  RowChange,
  SchemaChange,
  TableModel,
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
  SshProfile,
  SshProfileDraft,
  SshTest,
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
  /**
   * Tests a possibly unsaved draft; `id` reuses that profile's stored password. `ssh` is the SSH
   * profile as edited (tested before it is saved) and its typed password or passphrase.
   */
  connectionTest(
    draft: ConnectionDraft,
    id: string | null,
    password: string | null,
    ssh: SshTest | null,
  ): Promise<ServerInfo>;
  connectionConnect(
    id: string,
    password: string | null,
    sshSecret: string | null,
  ): Promise<ServerInfo>;
  connectionDisconnect(id: string): Promise<null>;
  connectionRename(id: string, name: string): Promise<ConnectionProfile>;
  /** Moves a data source into a folder (`null` = top level) at `index` among its data sources. */
  connectionMove(id: string, folderId: string | null, index: number): Promise<null>;
  /** Every schema of a draft's database (ignoring its schema scope), for the scope selector. */
  connectionSchemas(
    draft: ConnectionDraft,
    id: string | null,
    password: string | null,
    ssh: SshTest | null,
  ): Promise<string[]>;
  foldersList(): Promise<Folder[]>;
  folderCreate(name: string, color: string | null): Promise<Folder>;
  folderUpdate(folderId: string, name: string, color: string | null): Promise<Folder>;
  /** Deletes a folder; its data sources move to the top level. */
  folderDelete(folderId: string): Promise<null>;
  sshProfilesList(): Promise<SshProfile[]>;
  sshProfileCreate(draft: SshProfileDraft, secret: string | null): Promise<SshProfile>;
  sshProfileUpdate(
    profileId: string,
    draft: SshProfileDraft,
    secret: PasswordChange,
  ): Promise<SshProfile>;
  sshProfileDelete(profileId: string): Promise<null>;
  /** Trusts the host key the SSH server presented on the last attempt (by its fingerprint). */
  sshHostTrust(host: string, port: number, fingerprint: string): Promise<null>;
  /** Native open dialog; the chosen file's absolute path, or `null` if cancelled. */
  filePick(purpose: FilePurpose): Promise<string | null>;
  sessionsList(): Promise<SessionStatus[]>;
  /** Subscribes to session lifecycle events; resolves to an unsubscribe function. */
  onConnectionStatus(cb: (e: StatusEvent) => void): Promise<() => void>;
  /** One level of the explorer tree for a connected data source. */
  metadataChildren(id: string, request: MetadataRequest): Promise<MetaNode[]>;
  /** Everything the table viewer shows; `null` if the object no longer exists. */
  objectDetails(id: string, object: ObjectRef): Promise<ObjectDetails | null>;
  /** The editable model of a table (Modify Table); `null` if it no longer exists. */
  tableModel(id: string, schema: string, name: string): Promise<TableModel | null>;
  /** The exact statements a schema change would run. */
  schemaPreview(change: SchemaChange): Promise<string[]>;
  /** Runs statements in one transaction on a separate connection; all or nothing. */
  schemaApply(id: string, statements: string[]): Promise<null>;
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
  /** Renames a console file; rejects if `newName` is taken. */
  consoleRename(name: string, newName: string): Promise<null>;
  /** Copies a console; resolves to the copy's name. */
  consoleDuplicate(name: string): Promise<string>;
  /** Deletes a console file. */
  consoleDelete(name: string): Promise<null>;
  /** The directory console files live in (for tooltips). */
  consolesDir(): Promise<string>;
  /**
   * Cancels a slow explorer load on the shared session; `false` when a statement runs there (then
   * nothing is cancelled on the server).
   */
  metadataCancel(id: string): Promise<boolean>;
  /** Starts a query job; resolves to its id at once. Progress arrives through `onEvent`. */
  queryExecute(request: ExecRequest, onEvent: (e: ExecEvent) => void): Promise<string>;
  queryCancel(jobId: string): Promise<null>;
  /** Recorded statements matching `query`, newest first (at most 500 per call). */
  historySearch(query: HistoryQuery): Promise<HistoryEntry[]>;
  /** Removes history entries; resolves to how many were removed. */
  historyDelete(ids: number[]): Promise<number>;
  /** Removes every history entry of one data source; resolves to how many were removed. */
  historyClear(connectionId: string): Promise<number>;
  /** Saves every entry matching `query` via the native dialog; the path, or `null` if cancelled. */
  historyExport(query: HistoryQuery, format: HistoryExportFormat): Promise<string | null>;
  /** Native open dialog for a file to import; `null` if cancelled. */
  importPick(): Promise<ImportFile | null>;
  /** Columns, inferred types and the first `limit` rows of a chosen file. */
  importPreview(fileId: string, format: ImportFormat, limit: number): Promise<ImportPreview>;
  /** Starts an import; resolves to the job id. Progress and the outcome arrive on `onEvent`. */
  importRun(
    fileId: string,
    sourceId: string,
    plan: ImportPlan,
    onEvent: (e: ImportEvent) => void,
  ): Promise<string>;
  importCancel(job: string): Promise<null>;
  /** Saves a finished import's rejected rows as CSV; the path, or `null` if cancelled. */
  importErrorsSave(job: string): Promise<string | null>;
  /** Files dropped on the window (registered in Rust), with where they landed. */
  onFileDropped(cb: (e: DroppedFile) => void): Promise<() => void>;
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
  /**
   * Native save dialog + streamed export in the backend; `null` if the user cancelled the dialog
   * or the export (`resultExportCancel(job)`).
   */
  resultExport(
    session: SessionKey,
    cursor: string,
    columns: ColumnInfo[],
    format: ExportFormat,
    options: ExportOptions,
    fileName: string,
    job: string,
    onProgress: (rows: number) => void,
  ): Promise<ExportSummary | null>;
  /** Copies the whole result to the clipboard from the backend; `null` if cancelled. */
  resultCopy(
    session: SessionKey,
    cursor: string,
    columns: ColumnInfo[],
    format: ExportFormat,
    options: ExportOptions,
    job: string,
    onProgress: (rows: number) => void,
  ): Promise<CopySummary | null>;
  /** Stops a running export or whole-result copy. */
  resultExportCancel(job: string): Promise<null>;
  /** Formats rows the UI holds (a selection) as text in one of the export formats. */
  resultFormat(
    columns: ColumnInfo[],
    rows: Cell[][],
    format: ExportFormat,
    options: ExportOptions,
  ): Promise<string>;
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
  connectionTest: (draft, id, password, ssh) =>
    invoke<ServerInfo>('connection_test', { draft, id, password, ssh }),
  connectionConnect: (id, password, sshSecret) =>
    invoke<ServerInfo>('connection_connect', { id, password, sshSecret }),
  connectionDisconnect: (id) => invoke<null>('connection_disconnect', { id }),
  connectionRename: (id, name) => invoke<ConnectionProfile>('connection_rename', { id, name }),
  connectionMove: (id, folderId, index) => invoke<null>('connection_move', { id, folderId, index }),
  connectionSchemas: (draft, id, password, ssh) =>
    invoke<string[]>('connection_schemas', { draft, id, password, ssh }),
  foldersList: () => invoke<Folder[]>('folders_list'),
  folderCreate: (name, color) => invoke<Folder>('folder_create', { name, color }),
  folderUpdate: (folderId, name, color) =>
    invoke<Folder>('folder_update', { folderId, name, color }),
  folderDelete: (folderId) => invoke<null>('folder_delete', { folderId }),
  sshProfilesList: () => invoke<SshProfile[]>('ssh_profiles_list'),
  sshProfileCreate: (draft, secret) => invoke<SshProfile>('ssh_profile_create', { draft, secret }),
  sshProfileUpdate: (profileId, draft, secret) =>
    invoke<SshProfile>('ssh_profile_update', { profileId, draft, secret }),
  sshProfileDelete: (profileId) => invoke<null>('ssh_profile_delete', { profileId }),
  sshHostTrust: (host, port, fingerprint) =>
    invoke<null>('ssh_host_trust', { host, port, fingerprint }),
  filePick: (purpose) => invoke<string | null>('file_pick', { purpose }),
  sessionsList: () => invoke<SessionStatus[]>('sessions_list'),
  onConnectionStatus: (cb) => listen<StatusEvent>('connection-status', (e) => cb(e.payload)),
  metadataChildren: (id, request) => invoke<MetaNode[]>('metadata_children', { id, request }),
  objectDetails: (id, object) => invoke<ObjectDetails | null>('object_details', { id, object }),
  tableModel: (id, schema, name) => invoke<TableModel | null>('table_model', { id, schema, name }),
  schemaPreview: (change) => invoke<string[]>('schema_preview', { change }),
  schemaApply: (id, statements) => invoke<null>('schema_apply', { id, statements }),
  ddlGenerate: (id, objects, options) => invoke<string>('ddl_generate', { id, objects, options }),
  ddlSave: (id, objects, options, fileName) =>
    invoke<string | null>('ddl_save', { id, objects, options, fileName }),
  consoleList: () => invoke<string[]>('console_list'),
  consoleCreate: (preferred) => invoke<string>('console_create', { preferred }),
  consoleRead: (name) => invoke<string>('console_read', { name }),
  consoleWrite: (name, text) => invoke<null>('console_write', { name, text }),
  consoleRename: (name, newName) => invoke<null>('console_rename', { name, newName }),
  consoleDuplicate: (name) => invoke<string>('console_duplicate', { name }),
  consoleDelete: (name) => invoke<null>('console_delete', { name }),
  consolesDir: () => invoke<string>('consoles_dir'),
  metadataCancel: (id) => invoke<boolean>('metadata_cancel', { id }),
  queryExecute: (request, onEvent) => {
    const channel = new Channel<ExecEvent>();
    channel.onmessage = onEvent;
    return invoke<string>('query_execute', { request, onEvent: channel });
  },
  queryCancel: (jobId) => invoke<null>('query_cancel', { jobId }),
  historySearch: (query) => invoke<HistoryEntry[]>('history_search', { query }),
  historyDelete: (ids) => invoke<number>('history_delete', { ids }),
  historyClear: (connectionId) => invoke<number>('history_clear', { connectionId }),
  historyExport: (query, format) => invoke<string | null>('history_export', { query, format }),
  importPick: () => invoke<ImportFile | null>('import_pick'),
  importPreview: (fileId, format, limit) =>
    invoke<ImportPreview>('import_preview', { fileId, format, limit }),
  importRun: (fileId, sourceId, plan, onEvent) => {
    const channel = new Channel<ImportEvent>();
    channel.onmessage = onEvent;
    return invoke<string>('import_run', { fileId, sourceId, plan, onEvent: channel });
  },
  importCancel: (job) => invoke<null>('import_cancel', { job }),
  importErrorsSave: (job) => invoke<string | null>('import_errors_save', { job }),
  onFileDropped: (cb) => listen<DroppedFile>('file-dropped', (e) => cb(e.payload)),
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
  resultExport: (session, cursor, columns, format, options, fileName, job, onProgress) => {
    const channel = new Channel<number>();
    channel.onmessage = onProgress;
    return invoke<ExportSummary | null>('result_export', {
      session,
      cursor,
      columns,
      format,
      options,
      fileName,
      job,
      onProgress: channel,
    });
  },
  resultCopy: (session, cursor, columns, format, options, job, onProgress) => {
    const channel = new Channel<number>();
    channel.onmessage = onProgress;
    return invoke<CopySummary | null>('result_copy', {
      session,
      cursor,
      columns,
      format,
      options,
      job,
      onProgress: channel,
    });
  },
  resultExportCancel: (job) => invoke<null>('result_export_cancel', { job }),
  resultFormat: (columns, rows, format, options) =>
    invoke<string>('result_format', { columns, rows, format, options }),
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
