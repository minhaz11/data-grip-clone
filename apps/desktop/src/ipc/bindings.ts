// Generated from the Rust IPC types by src-tauri/src/bindings.rs. Do not edit.
// Regenerate with `npm run bindings`.

export type ThemePreference = "system" | "light" | "dark";

export type ResultTabs = "reuse" | "new";

export type OutsideStatement = "nearest" | "ask";

export type SelectionRun = "all" | "ask";

export type Settings = { theme: ThemePreference, editorFontSize: number, resultTabs: ResultTabs, 
/**
 * Statements running longer than this are cancelled; 0 = no limit.
 */
statementTimeoutSecs: number, 
/**
 * Runs longer than this show a notice and notify when done; 0 = never.
 */
longQuerySecs: number, runOutsideStatement: OutsideStatement, runSelection: SelectionRun, 
/**
 * Query history entries kept per data source; the oldest go first.
 */
historyLimit: number, 
/**
 * Query history older than this many days is removed; 0 = keep regardless of age.
 */
historyMaxAgeDays: number, 
/**
 * Local history: revisions kept per console; the oldest go first.
 */
revisionLimit: number, 
/**
 * Local history older than this many days is removed; 0 = keep regardless of age.
 */
revisionMaxAgeDays: number, 
/**
 * Minutes between automatic revisions while a console is being edited.
 */
revisionIntervalMins: number, 
/**
 * Shortcut overrides by action id; each replaces all of that action's default bindings
 * (an empty list unbinds it). Ids the UI no longer knows are ignored there.
 */
keymap: { [key in string]: Array<string> }, };

export type AiIgnoreKind = "table" | "column";

export type AiIgnoreRule = { kind: AiIgnoreKind, pattern: string, };

export type AiSettings = { 
/**
 * The kill switch: while false, no AI request leaves the app.
 */
enabled: boolean, model: string, 
/**
 * Workspaces where AI stays off even when it is enabled.
 */
disabledWorkspaces: Array<string>, ignore: Array<AiIgnoreRule>, };

export type ModelInfo = { id: string, displayName: string, };

export type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "refusal" | "other";

export type Usage = { inputTokens: number, outputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number, };

export type AiStatus = { settings: AiSettings, keyStored: boolean, workspaceId: string, 
/**
 * AI is enabled and not turned off for this workspace: requests may be sent.
 */
active: boolean, };

export type AiModels = { models: Array<ModelInfo>, 
/**
 * The list came from the provider (not the built-in fallback).
 */
live: boolean, 
/**
 * Why the live list could not be read, when that was tried.
 */
error?: string, };

export type AiStreamEvent = { "type": "started", model: string, } | { "type": "text", text: string, } | { "type": "done", stopReason: StopReason | null, usage: Usage, } | { "type": "failed", error: AppError, };

export type AiContextLevel = "none" | "schema" | "schemaAndRows";

export type AiLogStatus = "sent" | "done" | "failed" | "cancelled";

export type AiLogEntry = { id: number, 
/**
 * Unix milliseconds.
 */
createdAt: number, connectionId: string | null, connectionName: string, action: string, model: string, level: AiContextLevel, rowsSent: boolean, payload: string, status: AiLogStatus, response: string | null, error: string | null, inputTokens: number | null, outputTokens: number | null, finishedAt: number | null, };

export type AiConsent = { connectionId: string, 
/**
 * What may be sent now; `none` until the user decides.
 */
level: AiContextLevel, 
/**
 * The user chose a level (remembered, or for this run of the app).
 */
decided: boolean, 
/**
 * Kept in app.db (otherwise it lasts until the app restarts).
 */
remembered: boolean, rowsAlways: boolean, 
/**
 * What the consent dialog preselects: `none` for production sources.
 */
suggested: AiContextLevel, };

export type AiTask = { "kind": "ask", question: string, } | { "kind": "generate", request: string, } | { "kind": "explainQuery" } | { "kind": "explainError", error: string, } | { "kind": "fix", error: string, };

export type AiPreviewRequest = { connectionId: string, task: AiTask, 
/**
 * The editor's statement or selection.
 */
sql: string, 
/**
 * Objects selected or referenced by the SQL (resolved by the editor).
 */
objects: Array<ObjectRef>, 
/**
 * The user confirmed sending sample rows for this request.
 */
includeRows: boolean, };

export type OmitReason = "ignored" | "size" | "missing";

export type AiOmitted = { name: string, reason: OmitReason, };

export type AiRowTable = { table: string, columns: Array<string>, rows: number, };

export type AiPreview = { payloadId: string, connectionId: string, model: string, level: AiContextLevel, 
/**
 * The exact request body that Send transmits.
 */
body: string, bytes: number, 
/**
 * Rough count (four bytes a token), for the size shown next to the payload.
 */
estimatedTokens: number, 
/**
 * Objects whose schema is included.
 */
objects: Array<string>, omitted: Array<AiOmitted>, 
/**
 * Sample rows included.
 */
rows: Array<AiRowTable>, 
/**
 * Sample rows that could be included after the row consent prompt (columns and cap).
 */
rowOffer: Array<AiRowTable>, };

export type AppError = { kind: string, message: string, hint?: string, sqlstate?: string, 
/**
 * Set when `kind == "connect"`: which connection failure it was.
 */
connectKind?: ConnectErrorKind, 
/**
 * Set for `ssh_host_unknown` and `ssh_host_changed`: the key to show the user.
 */
hostKey?: HostKeyPrompt, 
/**
 * `Some(true)` when the failure happened while opening the SSH tunnel, before the database
 * was reached.
 */
tunnel?: boolean, };

export type HostKeyPrompt = { host: string, port: number, algorithm: string, 
/**
 * SHA-256 fingerprint as OpenSSH prints it (`SHA256:…`).
 */
fingerprint: string, 
/**
 * The fingerprint trusted before, when the key changed.
 */
expected?: string, };

export type ConnectErrorKind = "dns" | "refused" | "timeout" | "auth" | "password_required" | "database_missing" | "tls" | "server_unavailable" | "ssh_host_unknown" | "ssh_host_changed" | "ssh_secret_required" | "ssh" | "other";

export type Engine = "postgresql";

export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

export type Environment = "none" | "development" | "testing" | "staging" | "production";

export type SaveMode = "never" | "untilRestart" | "forever";

export type ConnectionDraft = { name: string, engine: Engine, host: string, port: number, database: string, username: string, sslMode: SslMode, connectTimeoutSecs: number, readOnly: boolean, environment: Environment, color: string | null, saveMode: SaveMode, 
/**
 * Transaction mode new sessions of this data source start in.
 */
txMode: TxMode, 
/**
 * Isolation level for transactions opened in Manual mode.
 */
isolation: Isolation, 
/**
 * Record every statement run against this data source in the query history.
 */
historyEnabled: boolean, 
/**
 * Folder in the Database Explorer; `None` is the top level.
 */
folderId: string | null, 
/**
 * Connect through this SSH profile's tunnel; `None` connects directly.
 */
sshProfileId: string | null, 
/**
 * PEM files (absolute paths) read at connect time: trusted CA, client certificate and key.
 */
tlsCaFile: string | null, tlsCertFile: string | null, tlsKeyFile: string | null, 
/**
 * TCP keep-alive idle time in seconds; 0 keeps the system default.
 */
keepaliveSecs: number, 
/**
 * Disconnect after this many idle minutes (no statement, no open transaction); 0 = never.
 */
autoDisconnectMins: number, 
/**
 * Statements run after every connect.
 */
startupSql: string, 
/**
 * Schemas the explorer and completion load; empty with an empty pattern means all.
 */
schemaNames: Array<string>, 
/**
 * Comma-separated wildcard patterns (`*`, `?`) for more schemas, e.g. `app_*`.
 */
schemaPattern: string, 
/**
 * The dialog shows the connection as a single URL instead of separate fields.
 */
urlOnly: boolean, };

export type ConnectionProfile = { id: string, 
/**
 * True when a password is in the OS credential store (save mode `forever`).
 */
passwordSaved: boolean, 
/**
 * Position within its folder (explorer order).
 */
sortOrder: number, createdAt: string, updatedAt: string, name: string, engine: Engine, host: string, port: number, database: string, username: string, sslMode: SslMode, connectTimeoutSecs: number, readOnly: boolean, environment: Environment, color: string | null, saveMode: SaveMode, 
/**
 * Transaction mode new sessions of this data source start in.
 */
txMode: TxMode, 
/**
 * Isolation level for transactions opened in Manual mode.
 */
isolation: Isolation, 
/**
 * Record every statement run against this data source in the query history.
 */
historyEnabled: boolean, 
/**
 * Folder in the Database Explorer; `None` is the top level.
 */
folderId: string | null, 
/**
 * Connect through this SSH profile's tunnel; `None` connects directly.
 */
sshProfileId: string | null, 
/**
 * PEM files (absolute paths) read at connect time: trusted CA, client certificate and key.
 */
tlsCaFile: string | null, tlsCertFile: string | null, tlsKeyFile: string | null, 
/**
 * TCP keep-alive idle time in seconds; 0 keeps the system default.
 */
keepaliveSecs: number, 
/**
 * Disconnect after this many idle minutes (no statement, no open transaction); 0 = never.
 */
autoDisconnectMins: number, 
/**
 * Statements run after every connect.
 */
startupSql: string, 
/**
 * Schemas the explorer and completion load; empty with an empty pattern means all.
 */
schemaNames: Array<string>, 
/**
 * Comma-separated wildcard patterns (`*`, `?`) for more schemas, e.g. `app_*`.
 */
schemaPattern: string, 
/**
 * The dialog shows the connection as a single URL instead of separate fields.
 */
urlOnly: boolean, };

export type PasswordChange = { "action": "keep" } | { "action": "set", "value": string } | { "action": "clear" };

export type Folder = { id: string, name: string, color: string | null, sortOrder: number, };

export type SshAuthMethod = "password" | "key" | "agent";

export type SshProfileDraft = { name: string, host: string, port: number, username: string, auth: SshAuthMethod, 
/**
 * Private key file (absolute path) for `Key` auth.
 */
keyFile: string | null, 
/**
 * Where the password (`Password` auth) or key passphrase (`Key` auth) is kept.
 */
saveMode: SaveMode, };

export type SshProfile = { id: string, 
/**
 * True when the password or passphrase is stored (for this run, with `untilRestart`).
 */
secretSaved: boolean, createdAt: string, updatedAt: string, name: string, host: string, port: number, username: string, auth: SshAuthMethod, 
/**
 * Private key file (absolute path) for `Key` auth.
 */
keyFile: string | null, 
/**
 * Where the password (`Password` auth) or key passphrase (`Key` auth) is kept.
 */
saveMode: SaveMode, };

export type FilePurpose = "sshKey" | "tlsCa" | "tlsCert" | "tlsKey";

export type SshTest = { 
/**
 * The SSH profile as edited; `None` uses the saved profile the draft refers to.
 */
profile?: SshProfileDraft, secret?: string, };

export type ServerInfo = { 
/**
 * Full version banner, e.g. "PostgreSQL 16.15 on x86_64-pc-linux-musl ...".
 */
version: string, 
/**
 * Short version, e.g. "16.15".
 */
serverVersion: string, database: string, user: string, tls: boolean, readOnly: boolean, 
/**
 * Wall time to resolve, connect, authenticate and run the probe query.
 */
latencyMs: number, };

export type SessionStatus = { id: string, info: ServerInfo, };

export type StatusEvent = { "state": "connected", id: string, info: ServerInfo, } | { "state": "disconnected", id: string, } | { "state": "lost", id: string, reason: string, };

export type SessionKey = { sourceId: string, 
/**
 * Console name for a console's own session; absent for the shared one.
 */
console?: string, };

export type SessionState = { session: SessionKey, open: boolean, status: TxStatus, settings: TxSettings, };

export type TxStatus = "idle" | "active" | "failed";

export type TxMode = "auto" | "manual";

export type Isolation = "read_committed" | "repeatable_read" | "serializable";

export type TxSettings = { mode: TxMode, isolation: Isolation, };

export type QuitResolution = "commit" | "rollback";

export type ObjectType = "table" | "view" | "materialized_view";

export type MetadataRequest = { "level": "schemas" } | { "level": "allSchemas" } | { "level": "schemaGroups", schema: string, } | { "level": "objects", schema: string, types: Array<ObjectType>, } | { "level": "objectGroups", schema: string, name: string, objectType: ObjectType, } | { "level": "columns", schema: string, table: string, } | { "level": "indexes", schema: string, table: string, } | { "level": "keys", schema: string, table: string, } | { "level": "foreignKeys", schema: string, table: string, } | { "level": "checks", schema: string, table: string, } | { "level": "triggers", schema: string, table: string, } | { "level": "routines", schema: string, } | { "level": "sequences", schema: string, } | { "level": "relations" } | { "level": "functions" } | { "level": "catalog" };

export type MetaKind = "schema" | "group" | "table" | "view" | "materialized_view" | "column" | "index" | "key" | "foreign_key" | "check" | "trigger" | "routine" | "sequence";

export type MetaNode = { 
/**
 * Unique among siblings and stable across refreshes (used for expansion state).
 */
key: string, kind: MetaKind, name: string, 
/**
 * Secondary text: column type, index definition, object comment.
 */
detail?: string, 
/**
 * For groups: number of children, when cheap to know up front.
 */
count?: number, 
/**
 * Short flags such as "pk", "not null", "unique", "primary".
 */
flags?: Array<string>, 
/**
 * `None` for leaves.
 */
children?: MetadataRequest, };

export type ObjectRef = { schema: string, name: string, objectType: ObjectType, };

export type ObjectDetails = { object: ObjectRef, comment: string | null, columns: Array<ColumnDetail>, indexes: Array<IndexDetail>, 
/**
 * Primary key, unique, check and exclusion constraints (foreign keys are below).
 */
constraints: Array<ConstraintDetail>, 
/**
 * Foreign keys this object declares.
 */
references: Array<ForeignKeyDetail>, 
/**
 * Foreign keys in other tables that point at this one.
 */
referencedBy: Array<ForeignKeyDetail>, triggers: Array<TriggerDetail>, 
/**
 * The planner's row estimate; absent until the table has been analyzed.
 */
rowEstimate: number | null, 
/**
 * Table plus indexes and TOAST, in bytes (absent for views).
 */
totalBytes: number | null, };

export type ColumnDetail = { name: string, 
/**
 * Full type, e.g. `character varying(80)`.
 */
typeName: string, nullable: boolean, default: string | null, primaryKey: boolean, 
/**
 * `always` / `by default` for identity columns.
 */
identity: string | null, 
/**
 * Expression of a generated column.
 */
generated: string | null, comment: string | null, };

export type IndexDetail = { name: string, 
/**
 * The server's definition after `USING`, e.g. `btree (email)`.
 */
definition: string, unique: boolean, primary: boolean, };

export type ConstraintDetail = { name: string, 
/**
 * `primary key`, `unique`, `check`, `exclusion`, `foreign key`.
 */
kind: string, 
/**
 * The server's definition, e.g. `CHECK ((qty > 0))`.
 */
definition: string, };

export type ForeignKeyDetail = { name: string, 
/**
 * The referencing table (for incoming keys) or this table (for outgoing ones).
 */
fromSchema: string, fromTable: string, fromColumns: Array<string>, toSchema: string, toTable: string, toColumns: Array<string>, onUpdate: string, onDelete: string, deferrable: boolean, };

export type TriggerDetail = { name: string, 
/**
 * The definition without `CREATE TRIGGER name`, e.g. `AFTER INSERT ON s.t FOR EACH ROW …`.
 */
definition: string, enabled: boolean, };

export type DdlObject = { "kind": "relation", schema: string, name: string, } | { "kind": "sequence", schema: string, name: string, } | { "kind": "routine", schema: string, name: string, args: string, } | { "kind": "index", schema: string, name: string, } | { "kind": "trigger", schema: string, table: string, name: string, } | { "kind": "schema", schema: string, };

export type DdlOptions = { 
/**
 * Schema-qualify every name (otherwise names in the object's own schema are bare).
 */
qualify: boolean, 
/**
 * Add `ALTER … OWNER TO`.
 */
owner: boolean, 
/**
 * Add `GRANT` statements from the object's privileges.
 */
grants: boolean, };

export type Identity = "always" | "by_default";

export type FkAction = "no_action" | "restrict" | "cascade" | "set_null" | "set_default";

export type ColumnModel = { name: string, 
/**
 * The column's name in the catalog (Modify Table); absent for a new column.
 */
original: string | null, 
/**
 * A type name such as `integer`, `character varying(80)` or `timestamp with time zone`.
 */
typeName: string, notNull: boolean, 
/**
 * A SQL expression, used as written.
 */
default: string | null, identity: Identity | null, comment: string | null, };

export type KeyModel = { 
/**
 * The constraint's name; absent lets the server choose one.
 */
name: string | null, columns: Array<string>, };

export type CheckModel = { name: string | null, 
/**
 * A boolean SQL expression, used as written.
 */
expression: string, };

export type ForeignKeyModel = { name: string | null, columns: Array<string>, refSchema: string, refTable: string, refColumns: Array<string>, onDelete: FkAction, onUpdate: FkAction, deferrable: boolean, };

export type IndexModel = { name: string | null, 
/**
 * What is indexed, as SQL: `email, created DESC`, or `btree (lower(email))` with a method.
 */
columns: string, unique: boolean, };

export type TableModel = { schema: string, name: string, comment: string | null, columns: Array<ColumnModel>, primaryKey: KeyModel | null, uniques: Array<KeyModel>, checks: Array<CheckModel>, foreignKeys: Array<ForeignKeyModel>, indexes: Array<IndexModel>, };

export type DropObject = { "kind": "relation", schema: string, name: string, objectType: ObjectType, } | { "kind": "sequence", schema: string, name: string, } | { "kind": "routine", schema: string, name: string, args: string, procedure: boolean, } | { "kind": "index", schema: string, name: string, } | { "kind": "trigger", schema: string, table: string, name: string, } | { "kind": "schema", schema: string, };

export type RenameObject = { "kind": "relation", schema: string, name: string, objectType: ObjectType, } | { "kind": "column", schema: string, table: string, name: string, } | { "kind": "schema", schema: string, };

export type TableName = { schema: string, name: string, };

export type SchemaChange = { "kind": "createTable", table: TableModel, } | { "kind": "alterTable", original: TableModel, table: TableModel, } | { "kind": "drop", objects: Array<DropObject>, ifExists: boolean, cascade: boolean, } | { "kind": "truncate", tables: Array<TableName>, restartIdentity: boolean, cascade: boolean, } | { "kind": "rename", object: RenameObject, newName: string, };

export type ColumnInfo = { name: string, 
/**
 * Engine type name ("int4", "text", ...) when the statement could be described.
 */
typeName?: string, };

export type StatementOutcome = { "type": "rows", columns: Array<ColumnInfo>, rows: Array<Array<string | null>>, 
/**
 * All rows the statement produced (may exceed `rows.len()`).
 */
totalRows: number, 
/**
 * `rows` is a prefix of the full result.
 */
truncated: boolean, 
/**
 * Server-side cursor holding the full result, for paging and export. `None` for results
 * that cannot be kept in a cursor (e.g. `INSERT … RETURNING`, `SHOW`); those return at
 * most `max_rows` rows.
 */
cursor?: string, 
/**
 * Whether rows can be edited (only computed for cursor-backed query results).
 */
edit?: Editability, } | { "type": "command", rowsAffected: number, };

export type StatementError = { message: string, detail: string | null, hint: string | null, sqlstate: string | null, 
/**
 * 1-based character position within the statement, from the server.
 */
position: number | null, cancelled: boolean, connectionLost: boolean, };

export type StatementRequest = { sql: string, 
/**
 * Where the statement starts in the console text; echoed back so the UI can map positions.
 */
offset: number, 
/**
 * Values for `$1…$n` (text; `null` is NULL), bound rather than spliced into the SQL.
 */
params?: Array<string | null>, };

export type ExecRequest = { session: SessionKey, statements: Array<StatementRequest>, maxRows?: number, 
/**
 * The console's schema, put first in the search path before the statements run; absent
 * means the server's default path.
 */
schema?: string, };

export type JobStatus = "completed" | "failed" | "cancelled";

export type ExecEvent = { "event": "statementStarted", index: number, offset: number, } | { "event": "statementDone", index: number, offset: number, elapsedMs: number, outcome: StatementOutcome, } | { "event": "statementFailed", index: number, offset: number, elapsedMs: number, error: StatementError, } | { "event": "notice", index: number, notice: Notice, } | { "event": "finished", status: JobStatus, executed: number, elapsedMs: number, };

export type HistoryStatus = "ok" | "error" | "cancelled";

export type HistoryEntry = { id: number, connectionId: string, console: string | null, sql: string, 
/**
 * Unix time in milliseconds.
 */
startedAt: number, durationMs: number, status: HistoryStatus, rowCount: number | null, error: string | null, txMode: TxMode, };

export type HistoryQuery = { 
/**
 * Only this data source's entries; absent for all of them.
 */
connectionId?: string, text: string, limit: number, offset: number, };

export type HistoryExportFormat = "csv" | "json";

export type SnippetDialect = "postgresql" | "any";

export type SnippetDraft = { 
/**
 * What is typed before Tab: letters, digits and `_`.
 */
abbreviation: string, description: string, body: string, dialect: SnippetDialect, };

export type Snippet = { id: string, createdAt: string, updatedAt: string, 
/**
 * What is typed before Tab: letters, digits and `_`.
 */
abbreviation: string, description: string, body: string, dialect: SnippetDialect, };

export type SnippetFile = { 
/**
 * Always `quarry-snippets`.
 */
format: string, version: number, snippets: Array<SnippetDraft>, };

export type SnippetImport = { added: number, replaced: number, };

export type RevisionReason = "auto" | "beforeDeletion" | "external" | "beforeRun" | "beforeFormat" | "beforeRestore" | "beforeDelete";

export type RevisionInfo = { id: number, 
/**
 * Unix time in milliseconds.
 */
createdAt: number, reason: RevisionReason, 
/**
 * Bytes of text.
 */
size: number, 
/**
 * The first non-blank line, for recognizing a revision in the list.
 */
firstLine: string, };

export type SortKey = { column: number, descending: boolean, };

export type Filter = { column: number, op: FilterOp, 
/**
 * Text form of the comparison value; `None` for `IsNull`/`NotNull`.
 */
value: string | null, };

export type FilterOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "contains" | "starts_with" | "is_null" | "not_null";

export type Refinement = { 
/**
 * Applied in order (first key sorts first).
 */
sort: Array<SortKey>, 
/**
 * All must hold (AND).
 */
filters: Array<Filter>, };

export type EditColumn = { name: string, typeName: string, };

export type EditTarget = { schema: string, table: string, 
/**
 * Per result column: the base column it shows, or `None` if it cannot be edited
 * (computed, from another table, a repeat of an earlier column, or an unsupported type).
 */
columns: Array<EditColumn | null>, 
/**
 * Result-column positions of the primary key, in key order.
 */
key: Array<number>, };

export type Editability = { "status": "editable", target: EditTarget, } | { "status": "readOnly", reason: string, };

export type ColumnValue = { 
/**
 * Result-column position.
 */
column: number, value: string | null, };

export type RowChange = { "kind": "update", key: Array<string | null>, set: Array<ColumnValue>, original: Array<ColumnValue>, 
/**
 * Result-column positions set to the column default (`SET col = DEFAULT`).
 */
defaults: Array<number>, } | { "kind": "delete", key: Array<string | null>, } | { "kind": "insert", values: Array<ColumnValue>, };

export type EditStatement = { sql: string, params: Array<string | null>, };

export type Notice = { 
/**
 * `NOTICE`, `WARNING`, `INFO`, `LOG` or `DEBUG`.
 */
severity: string, message: string, detail: string | null, hint: string | null, sqlstate: string, };

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown";

export type ExportColumn = { name: string, typeName: string | null, };

export type ExportSummary = { path: string, rows: number, bytes: number, };

export type ExportOptions = { nullText?: string | null, quoteAll: boolean, header: boolean, 
/**
 * SQL INSERT target; absent uses a placeholder name.
 */
table?: TableName | null, };

export type CopySummary = { rows: number, bytes: number, };

export type FileKind = "delimited" | "jsonArray" | "jsonLines";

export type ImportFormat = { kind: FileKind, 
/**
 * An Encoding Standard label (`utf-8`, `windows-1252`, `utf-16le`, ...); `None` detects it.
 */
encoding: string | null, 
/**
 * Delimited files: the field separator.
 */
delimiter: string, quote: string, 
/**
 * A character that escapes the next one inside quotes; `None` means quotes are doubled.
 */
escape: string | null, 
/**
 * The first record holds the column names.
 */
header: boolean, 
/**
 * Removes spaces around unquoted values.
 */
trim: boolean, 
/**
 * An unquoted value equal to this is NULL (`\N`, `NULL`, ...).
 */
nullToken: string | null, 
/**
 * An unquoted empty value is NULL; a quoted empty one (`""`) stays an empty string.
 */
emptyIsNull: boolean, };

export type Detected = { format: ImportFormat, 
/**
 * The encoding the sample was decoded with.
 */
encoding: string, };

export type ErrorPolicy = "abort" | "skip" | "null";

export type ColumnMapping = { 
/**
 * Index into the source columns.
 */
source: number, target: string, 
/**
 * The target column's type, for checking values before they are sent.
 */
typeName: string, };

export type ImportPlan = { format: ImportFormat, 
/**
 * The file's columns, as the preview found them (JSON keys, or the header/positions).
 */
sourceColumns: Array<string>, mapping: Array<ColumnMapping>, table: TableName, 
/**
 * Statements run first in the same transaction (CREATE TABLE for a new table).
 */
setup: Array<string>, policy: ErrorPolicy, };

export type ImportProgress = { rows: number, rejected: number, bytes: number, totalBytes: number, };

export type Rejected = { 
/**
 * Line in the file (record number for a JSON array).
 */
line: number, column: string | null, message: string, 
/**
 * Loaded with NULL instead of left out.
 */
nulled: boolean, };

export type ImportSummary = { rows: number, 
/**
 * The first rejected rows (at most `MAX_LISTED`); `rejected_count` has them all.
 */
rejected: Array<Rejected>, rejectedCount: number, 
/**
 * Values set to NULL under the NULL policy.
 */
nulled: number, elapsedMs: number, 
/**
 * Cancelled: nothing was loaded.
 */
cancelled: boolean, };

export type ImportFile = { id: string, name: string, size: number, detected: Detected, };

export type DroppedFile = { file: ImportFile, x: number, y: number, };

export type ImportPreview = { columns: Array<string>, 
/**
 * The type each column's sample values fit best.
 */
inferred: Array<string>, rows: Array<Array<string | null>>, 
/**
 * Line of each preview row in the file.
 */
lines: Array<number>, 
/**
 * Rows the whole file probably has, from the sample's average size.
 */
estimatedRows: number, };

export type ImportEvent = { "event": "progress" } & ImportProgress | { "event": "done" } & ImportSummary | { "event": "failed", error: AppError, };
