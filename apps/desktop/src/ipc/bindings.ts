// Generated from the Rust IPC types by src-tauri/src/bindings.rs. Do not edit.
// Regenerate with `npm run bindings`.

export type ThemePreference = "system" | "light" | "dark";

export type ResultTabs = "reuse" | "new";

export type Settings = { theme: ThemePreference, editorFontSize: number, resultTabs: ResultTabs, };

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

export type MetadataRequest = { "level": "schemas" } | { "level": "schemaGroups", schema: string, } | { "level": "objects", schema: string, types: Array<ObjectType>, } | { "level": "objectGroups", schema: string, name: string, objectType: ObjectType, } | { "level": "columns", schema: string, table: string, } | { "level": "indexes", schema: string, table: string, } | { "level": "keys", schema: string, table: string, } | { "level": "foreignKeys", schema: string, table: string, } | { "level": "checks", schema: string, table: string, } | { "level": "triggers", schema: string, table: string, } | { "level": "routines", schema: string, } | { "level": "sequences", schema: string, } | { "level": "relations" };

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

export type RowChange = { "kind": "update", key: Array<string | null>, set: Array<ColumnValue>, original: Array<ColumnValue>, 
/**
 * Result-column positions set to the column default (`SET col = DEFAULT`).
 */
defaults: Array<number>, } | { "kind": "delete", key: Array<string | null>, } | { "kind": "insert", values: Array<ColumnValue>, };

export type EditStatement = { sql: string, params: Array<string | null>, };

export type ExportFormat = "csv" | "tsv" | "json" | "sql" | "markdown";

export type ExportColumn = { name: string, typeName: string | null, };

export type ExportSummary = { path: string, rows: number, bytes: number, };

export type ExportOptions = { nullText?: string | null, quoteAll: boolean, header: boolean, 
/**
 * SQL INSERT target; absent uses a placeholder name.
 */
table?: TableName | null, };

export type CopySummary = { rows: number, bytes: number, };
