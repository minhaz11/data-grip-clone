// Generated from the Rust IPC types by src-tauri/src/bindings.rs. Do not edit.
// Regenerate with `npm run bindings`.

export type ThemePreference = "system" | "light" | "dark";

export type Settings = { theme: ThemePreference, editorFontSize: number, };

export type AppError = { kind: string, message: string, hint?: string, sqlstate?: string, 
/**
 * Set when `kind == "connect"`: which connection failure it was.
 */
connectKind?: ConnectErrorKind, };

export type ConnectErrorKind = "dns" | "refused" | "timeout" | "auth" | "password_required" | "database_missing" | "tls" | "server_unavailable" | "other";

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
isolation: Isolation, };

export type ConnectionProfile = { id: string, 
/**
 * True when a password is in the OS credential store (save mode `forever`).
 */
passwordSaved: boolean, createdAt: string, updatedAt: string, name: string, engine: Engine, host: string, port: number, database: string, username: string, sslMode: SslMode, connectTimeoutSecs: number, readOnly: boolean, environment: Environment, color: string | null, saveMode: SaveMode, 
/**
 * Transaction mode new sessions of this data source start in.
 */
txMode: TxMode, 
/**
 * Isolation level for transactions opened in Manual mode.
 */
isolation: Isolation, };

export type PasswordChange = { "action": "keep" } | { "action": "set", "value": string } | { "action": "clear" };

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

export type MetadataRequest = { "level": "schemas" } | { "level": "schemaGroups", schema: string, } | { "level": "objects", schema: string, types: Array<ObjectType>, } | { "level": "objectGroups", schema: string, name: string, objectType: ObjectType, } | { "level": "columns", schema: string, table: string, } | { "level": "indexes", schema: string, table: string, } | { "level": "relations" };

export type MetaKind = "schema" | "group" | "table" | "view" | "materialized_view" | "column" | "index";

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
offset: number, };

export type ExecRequest = { session: SessionKey, statements: Array<StatementRequest>, maxRows?: number, 
/**
 * The console's schema, put first in the search path before the statements run; absent
 * means the server's default path.
 */
schema?: string, };

export type JobStatus = "completed" | "failed" | "cancelled";

export type ExecEvent = { "event": "statementStarted", index: number, offset: number, } | { "event": "statementDone", index: number, offset: number, elapsedMs: number, outcome: StatementOutcome, } | { "event": "statementFailed", index: number, offset: number, elapsedMs: number, error: StatementError, } | { "event": "finished", status: JobStatus, executed: number, elapsedMs: number, };

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

export type RowChange = { "kind": "update", key: Array<string | null>, set: Array<ColumnValue>, original: Array<ColumnValue>, } | { "kind": "delete", key: Array<string | null>, } | { "kind": "insert", values: Array<ColumnValue>, };

export type EditStatement = { sql: string, params: Array<string | null>, };

export type ExportFormat = "csv" | "json";

export type ExportColumn = { name: string, typeName: string | null, };

export type ExportSummary = { path: string, rows: number, bytes: number, };
