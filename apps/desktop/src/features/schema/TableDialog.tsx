import { Plus, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { backend } from '../../ipc/client';
import type {
  ColumnModel,
  ConnectionProfile,
  FkAction,
  Identity,
  TableModel,
} from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { ChangeDialog } from './ChangeDialog';

const COMMON_TYPES = [
  'integer',
  'bigint',
  'smallint',
  'numeric(12, 2)',
  'text',
  'character varying(255)',
  'boolean',
  'date',
  'timestamp with time zone',
  'timestamp without time zone',
  'uuid',
  'jsonb',
  'bytea',
  'text[]',
];

const ACTIONS: { value: FkAction; label: string }[] = [
  { value: 'no_action', label: 'NO ACTION' },
  { value: 'restrict', label: 'RESTRICT' },
  { value: 'cascade', label: 'CASCADE' },
  { value: 'set_null', label: 'SET NULL' },
  { value: 'set_default', label: 'SET DEFAULT' },
];

const input = 'w-full min-w-0 rounded border border-border bg-bg px-1.5 py-0.5';
const removeButton = 'rounded p-0.5 text-muted hover:bg-hover hover:text-fg';

function emptyColumn(): ColumnModel {
  return {
    name: '',
    original: null,
    typeName: 'text',
    notNull: false,
    default: null,
    identity: null,
    comment: null,
  };
}

function blankTable(schema: string): TableModel {
  return {
    schema,
    name: '',
    comment: null,
    columns: [
      { ...emptyColumn(), name: 'id', typeName: 'bigint', notNull: true, identity: 'always' },
    ],
    primaryKey: { name: null, columns: ['id'] },
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
  };
}

const parseList = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** A comma-separated list that keeps what is typed (trailing commas included) while editing. */
function ListInput({
  value,
  onChange,
  label,
}: {
  value: string[];
  onChange(next: string[]): void;
  label: string;
}) {
  const [text, setText] = useState(value.join(', '));
  return (
    <input
      aria-label={label}
      value={text}
      placeholder="a, b"
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseList(e.target.value));
      }}
      className={input}
    />
  );
}

function Section({
  title,
  onAdd,
  children,
}: {
  title: string;
  onAdd(): void;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-1">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</h3>
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-0.5 text-accent hover:underline"
          aria-label={`Add to ${title.toLowerCase()}`}
        >
          <Plus size={12} aria-hidden /> Add
        </button>
      </div>
      {children}
    </section>
  );
}

/** Create Table and Modify Table (REQ-SCHEMA-01, 03): one form, statements previewed live. */
export function TableDialog({
  source,
  schema,
  table,
  onApplied,
  onClose,
}: {
  source: ConnectionProfile;
  schema: string;
  /** The table to modify; absent to create one. */
  table?: string;
  onApplied(model: TableModel): void;
  onClose(): void;
}) {
  const [original, setOriginal] = useState<TableModel | null>(null);
  const [model, setModel] = useState<TableModel | null>(table ? null : blankTable(schema));
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!table) {
      return;
    }
    let cancelled = false;
    backend
      .tableModel(source.id, schema, table)
      .then((m) => {
        if (cancelled) {
          return;
        }
        if (!m) {
          setLoadError(`${schema}.${table} no longer exists.`);
          return;
        }
        setOriginal(m);
        setModel(structuredClone(m));
      })
      .catch((e: unknown) => !cancelled && setLoadError(toAppError(e).message));
    return () => {
      cancelled = true;
    };
  }, [source.id, schema, table]);

  const change = model
    ? original
      ? { kind: 'alterTable' as const, original, table: model }
      : { kind: 'createTable' as const, table: model }
    : null;
  const update = (f: (m: TableModel) => TableModel) => setModel((m) => (m ? f(m) : m));
  const setColumn = (i: number, patch: Partial<ColumnModel>) =>
    update((m) => {
      const old = m.columns[i];
      const columns = m.columns.map((c, j) => (j === i ? { ...c, ...patch } : c));
      // Keys follow a renamed column.
      const rename = (cols: string[]) =>
        patch.name !== undefined && old
          ? cols.map((c) => (c === old.name ? (patch.name ?? c) : c))
          : cols;
      return {
        ...m,
        columns,
        primaryKey: m.primaryKey
          ? { ...m.primaryKey, columns: rename(m.primaryKey.columns) }
          : null,
      };
    });
  const togglePk = (name: string, on: boolean) =>
    update((m) => {
      const columns = (m.primaryKey?.columns ?? []).filter((c) => c !== name);
      if (on) {
        columns.push(name);
      }
      return {
        ...m,
        primaryKey: columns.length ? { name: m.primaryKey?.name ?? null, columns } : null,
      };
    });

  const title = table ? `Modify ${schema}.${table}` : `New table in ${schema}`;
  return (
    <ChangeDialog
      title={title}
      source={source}
      change={change}
      applyLabel={table ? 'Apply' : 'Create'}
      width={980}
      onApplied={() => model && onApplied(model)}
      onClose={onClose}
    >
      {loadError && (
        <p role="alert" className="text-danger">
          {loadError}
        </p>
      )}
      {!model && !loadError && <p role="status">Loading…</p>}
      {model && (
        <div className="max-h-[50vh] space-y-3 overflow-auto pr-1">
          <div className="grid grid-cols-[max-content_1fr_max-content_2fr] items-center gap-2">
            <label htmlFor="table-name">Name</label>
            <input
              id="table-name"
              value={model.name}
              onChange={(e) => update((m) => ({ ...m, name: e.target.value }))}
              className={input}
            />
            <label htmlFor="table-comment">Comment</label>
            <input
              id="table-comment"
              value={model.comment ?? ''}
              onChange={(e) => update((m) => ({ ...m, comment: e.target.value || null }))}
              className={input}
            />
          </div>

          <Section
            title="Columns"
            onAdd={() => update((m) => ({ ...m, columns: [...m.columns, emptyColumn()] }))}
          >
            <datalist id="table-types">
              {COMMON_TYPES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="text-left text-muted">
                  {['Name', 'Type', 'Not null', 'Default', 'Identity', 'PK', 'Comment', ''].map(
                    (h) => (
                      <th key={h} scope="col" className="pr-2 font-normal">
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {model.columns.map((c, i) => {
                  const n = i + 1;
                  return (
                    <tr key={c.original ?? `new-${i}`}>
                      <td className="pr-2">
                        <input
                          aria-label={`Column ${n} name`}
                          value={c.name}
                          onChange={(e) => setColumn(i, { name: e.target.value })}
                          className={input}
                        />
                      </td>
                      <td className="pr-2">
                        <input
                          aria-label={`Column ${n} type`}
                          list="table-types"
                          value={c.typeName}
                          onChange={(e) => setColumn(i, { typeName: e.target.value })}
                          className={`${input} font-mono`}
                        />
                      </td>
                      <td className="pr-2 text-center">
                        <input
                          type="checkbox"
                          aria-label={`Column ${n} not null`}
                          checked={c.notNull}
                          onChange={(e) => setColumn(i, { notNull: e.target.checked })}
                        />
                      </td>
                      <td className="pr-2">
                        <input
                          aria-label={`Column ${n} default`}
                          value={c.default ?? ''}
                          disabled={c.identity !== null}
                          onChange={(e) => setColumn(i, { default: e.target.value || null })}
                          className={`${input} font-mono`}
                        />
                      </td>
                      <td className="pr-2">
                        <select
                          aria-label={`Column ${n} identity`}
                          value={c.identity ?? ''}
                          onChange={(e) =>
                            setColumn(i, {
                              identity: (e.target.value || null) as Identity | null,
                              default: e.target.value ? null : c.default,
                            })
                          }
                          className={input}
                        >
                          <option value="">none</option>
                          <option value="always">always</option>
                          <option value="by_default">by default</option>
                        </select>
                      </td>
                      <td className="pr-2 text-center">
                        <input
                          type="checkbox"
                          aria-label={`Column ${n} in primary key`}
                          checked={model.primaryKey?.columns.includes(c.name) ?? false}
                          disabled={!c.name}
                          onChange={(e) => togglePk(c.name, e.target.checked)}
                        />
                      </td>
                      <td className="pr-2">
                        <input
                          aria-label={`Column ${n} comment`}
                          value={c.comment ?? ''}
                          onChange={(e) => setColumn(i, { comment: e.target.value || null })}
                          className={input}
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          aria-label={`Remove column ${n}`}
                          onClick={() =>
                            update((m) => ({
                              ...m,
                              columns: m.columns.filter((_, j) => j !== i),
                              primaryKey: m.primaryKey
                                ? {
                                    ...m.primaryKey,
                                    columns: m.primaryKey.columns.filter((x) => x !== c.name),
                                  }
                                : null,
                            }))
                          }
                          className={removeButton}
                        >
                          <X size={12} aria-hidden />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Section>

          <Section
            title="Unique constraints"
            onAdd={() =>
              update((m) => ({ ...m, uniques: [...m.uniques, { name: null, columns: [] }] }))
            }
          >
            {model.uniques.map((u, i) => (
              <div key={u.name ?? `u-${i}`} className="grid grid-cols-[1fr_2fr_auto] gap-2">
                <input
                  aria-label={`Unique ${i + 1} name`}
                  placeholder="name (optional)"
                  value={u.name ?? ''}
                  onChange={(e) =>
                    update((m) => ({
                      ...m,
                      uniques: m.uniques.map((x, j) =>
                        j === i ? { ...x, name: e.target.value || null } : x,
                      ),
                    }))
                  }
                  className={input}
                />
                <ListInput
                  label={`Unique ${i + 1} columns`}
                  value={u.columns}
                  onChange={(columns) =>
                    update((m) => ({
                      ...m,
                      uniques: m.uniques.map((x, j) => (j === i ? { ...x, columns } : x)),
                    }))
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove unique ${i + 1}`}
                  onClick={() =>
                    update((m) => ({ ...m, uniques: m.uniques.filter((_, j) => j !== i) }))
                  }
                  className={removeButton}
                >
                  <X size={12} aria-hidden />
                </button>
              </div>
            ))}
          </Section>

          <Section
            title="Checks"
            onAdd={() =>
              update((m) => ({ ...m, checks: [...m.checks, { name: null, expression: '' }] }))
            }
          >
            {model.checks.map((c, i) => (
              <div key={c.name ?? `c-${i}`} className="grid grid-cols-[1fr_2fr_auto] gap-2">
                <input
                  aria-label={`Check ${i + 1} name`}
                  placeholder="name (optional)"
                  value={c.name ?? ''}
                  onChange={(e) =>
                    update((m) => ({
                      ...m,
                      checks: m.checks.map((x, j) =>
                        j === i ? { ...x, name: e.target.value || null } : x,
                      ),
                    }))
                  }
                  className={input}
                />
                <input
                  aria-label={`Check ${i + 1} expression`}
                  placeholder="qty > 0"
                  value={c.expression}
                  onChange={(e) =>
                    update((m) => ({
                      ...m,
                      checks: m.checks.map((x, j) =>
                        j === i ? { ...x, expression: e.target.value } : x,
                      ),
                    }))
                  }
                  className={`${input} font-mono`}
                />
                <button
                  type="button"
                  aria-label={`Remove check ${i + 1}`}
                  onClick={() =>
                    update((m) => ({ ...m, checks: m.checks.filter((_, j) => j !== i) }))
                  }
                  className={removeButton}
                >
                  <X size={12} aria-hidden />
                </button>
              </div>
            ))}
          </Section>

          <Section
            title="Foreign keys"
            onAdd={() =>
              update((m) => ({
                ...m,
                foreignKeys: [
                  ...m.foreignKeys,
                  {
                    name: null,
                    columns: [],
                    refSchema: m.schema,
                    refTable: '',
                    refColumns: [],
                    onDelete: 'no_action',
                    onUpdate: 'no_action',
                    deferrable: false,
                  },
                ],
              }))
            }
          >
            {model.foreignKeys.map((f, i) => {
              const n = i + 1;
              const set = (patch: Partial<typeof f>) =>
                update((m) => ({
                  ...m,
                  foreignKeys: m.foreignKeys.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                }));
              return (
                <div
                  key={f.name ?? `f-${i}`}
                  className="grid grid-cols-[1fr_1fr_1fr_1fr_auto_auto_auto_auto] items-center gap-2"
                >
                  <input
                    aria-label={`Foreign key ${n} name`}
                    placeholder="name (optional)"
                    value={f.name ?? ''}
                    onChange={(e) => set({ name: e.target.value || null })}
                    className={input}
                  />
                  <ListInput
                    label={`Foreign key ${n} columns`}
                    value={f.columns}
                    onChange={(columns) => set({ columns })}
                  />
                  <input
                    aria-label={`Foreign key ${n} references table`}
                    placeholder="schema.table"
                    defaultValue={f.refTable ? `${f.refSchema}.${f.refTable}` : ''}
                    onChange={(e) => {
                      const text = e.target.value.trim();
                      const dot = text.indexOf('.');
                      set(
                        dot > 0
                          ? { refSchema: text.slice(0, dot), refTable: text.slice(dot + 1) }
                          : { refSchema: model.schema, refTable: text },
                      );
                    }}
                    className={input}
                  />
                  <ListInput
                    label={`Foreign key ${n} referenced columns`}
                    value={f.refColumns}
                    onChange={(refColumns) => set({ refColumns })}
                  />
                  <select
                    aria-label={`Foreign key ${n} on delete`}
                    value={f.onDelete}
                    onChange={(e) => set({ onDelete: e.target.value as FkAction })}
                    className={input}
                  >
                    {ACTIONS.map((a) => (
                      <option key={a.value} value={a.value}>
                        ON DELETE {a.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`Foreign key ${n} on update`}
                    value={f.onUpdate}
                    onChange={(e) => set({ onUpdate: e.target.value as FkAction })}
                    className={input}
                  >
                    {ACTIONS.map((a) => (
                      <option key={a.value} value={a.value}>
                        ON UPDATE {a.label}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 whitespace-nowrap">
                    <input
                      type="checkbox"
                      checked={f.deferrable}
                      onChange={(e) => set({ deferrable: e.target.checked })}
                    />
                    Deferrable
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove foreign key ${n}`}
                    onClick={() =>
                      update((m) => ({
                        ...m,
                        foreignKeys: m.foreignKeys.filter((_, j) => j !== i),
                      }))
                    }
                    className={removeButton}
                  >
                    <X size={12} aria-hidden />
                  </button>
                </div>
              );
            })}
          </Section>

          <Section
            title="Indexes"
            onAdd={() =>
              update((m) => ({
                ...m,
                indexes: [...m.indexes, { name: null, columns: '', unique: false }],
              }))
            }
          >
            {model.indexes.map((x, i) => (
              <div
                key={x.name ?? `i-${i}`}
                className="grid grid-cols-[1fr_2fr_auto_auto] items-center gap-2"
              >
                <input
                  aria-label={`Index ${i + 1} name`}
                  placeholder="name (optional)"
                  value={x.name ?? ''}
                  onChange={(e) =>
                    update((m) => ({
                      ...m,
                      indexes: m.indexes.map((y, j) =>
                        j === i ? { ...y, name: e.target.value || null } : y,
                      ),
                    }))
                  }
                  className={input}
                />
                <input
                  aria-label={`Index ${i + 1} columns`}
                  placeholder="email, created DESC"
                  value={x.columns}
                  onChange={(e) =>
                    update((m) => ({
                      ...m,
                      indexes: m.indexes.map((y, j) =>
                        j === i ? { ...y, columns: e.target.value } : y,
                      ),
                    }))
                  }
                  className={`${input} font-mono`}
                />
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={x.unique}
                    onChange={(e) =>
                      update((m) => ({
                        ...m,
                        indexes: m.indexes.map((y, j) =>
                          j === i ? { ...y, unique: e.target.checked } : y,
                        ),
                      }))
                    }
                  />
                  Unique
                </label>
                <button
                  type="button"
                  aria-label={`Remove index ${i + 1}`}
                  onClick={() =>
                    update((m) => ({ ...m, indexes: m.indexes.filter((_, j) => j !== i) }))
                  }
                  className={removeButton}
                >
                  <X size={12} aria-hidden />
                </button>
              </div>
            ))}
          </Section>
        </div>
      )}
    </ChangeDialog>
  );
}
