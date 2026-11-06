import type {
  ColumnModel,
  ErrorPolicy,
  ImportFormat,
  ImportPlan,
  ImportPreview,
  TableModel,
} from '../../ipc/types';

/** One source column in the mapping grid. */
export interface MappedColumn {
  /** Index into the file's columns. */
  source: number;
  include: boolean;
  /** Target column name (a new table's column, or an existing one). */
  target: string;
  /** Type of the target column (inferred for a new table, read from an existing one). */
  type: string;
}

export const TYPE_SUGGESTIONS = [
  'text',
  'integer',
  'bigint',
  'numeric',
  'double precision',
  'boolean',
  'date',
  'timestamp',
  'timestamp with time zone',
  'time',
  'uuid',
  'jsonb',
  'character varying(255)',
];

/** A column name PostgreSQL accepts without quoting: lower case, `_` for anything else. */
export function columnName(header: string, index: number): string {
  const name = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!name) {
    return `column_${index + 1}`;
  }
  return /^[0-9]/.test(name) ? `c_${name}` : name.slice(0, 63);
}

/**
 * The starting mapping: every file column, named after its header. For an existing table, a
 * column whose name matches a table column (ignoring case and `_`) maps to it; others are left
 * out.
 */
export function initialMapping(
  preview: Pick<ImportPreview, 'columns' | 'inferred'>,
  existing: Pick<ColumnModel, 'name' | 'typeName'>[] | null,
): MappedColumn[] {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return preview.columns.map((header, source) => {
    if (existing) {
      const match = existing.find((c) => key(c.name) === key(header));
      return {
        source,
        include: !!match,
        target: match?.name ?? '',
        type: match?.typeName ?? 'text',
      };
    }
    return {
      source,
      include: true,
      target: columnName(header, source),
      type: preview.inferred[source] ?? 'text',
    };
  });
}

/** Why the mapping cannot be imported yet, or `null`. */
export function mappingProblem(mapping: MappedColumn[]): string | null {
  const used = mapping.filter((m) => m.include);
  if (used.length === 0) {
    return 'Choose at least one column to import.';
  }
  if (used.some((m) => !m.target.trim())) {
    return 'Every imported column needs a target column.';
  }
  const names = used.map((m) => m.target.trim().toLowerCase());
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) {
    return `Column "${dup}" is used twice.`;
  }
  if (used.some((m) => !m.type.trim())) {
    return 'Every new column needs a type.';
  }
  return null;
}

/** The table a new-table import creates. */
export function newTableModel(schema: string, name: string, mapping: MappedColumn[]): TableModel {
  return {
    schema,
    name,
    comment: null,
    columns: mapping
      .filter((m) => m.include)
      .map((m) => ({
        name: m.target.trim(),
        original: null,
        typeName: m.type.trim(),
        notNull: false,
        default: null,
        identity: null,
        comment: null,
      })),
    primaryKey: null,
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
  };
}

export function buildPlan(args: {
  format: ImportFormat;
  columns: string[];
  mapping: MappedColumn[];
  schema: string;
  table: string;
  setup: string[];
  policy: ErrorPolicy;
}): ImportPlan {
  return {
    format: args.format,
    sourceColumns: args.columns,
    mapping: args.mapping
      .filter((m) => m.include)
      .map((m) => ({ source: m.source, target: m.target.trim(), typeName: m.type.trim() })),
    table: { schema: args.schema, name: args.table },
    setup: args.setup,
    policy: args.policy,
  };
}

/** "1.2 MB" style sizes. */
export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}
