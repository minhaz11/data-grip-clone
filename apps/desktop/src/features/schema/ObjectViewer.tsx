import { KeyRound, RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { askPasswordAndConnect } from '../../app/dialogs';
import { backend } from '../../ipc/client';
import type { ColumnDetail, ForeignKeyDetail, ObjectDetails, ObjectRef } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { useConnections } from '../connections/connectionsStore';
import { useSessions } from '../connections/sessionsStore';

type Result = { details: ObjectDetails | null } | { error: string };

/** Loads an object's details while its data source is connected; `reload` fetches them again. */
export function useObjectDetails(sourceId: string, object: ObjectRef) {
  const connected = useSessions((s) => s.byId[sourceId]?.state === 'connected');
  const [token, setToken] = useState(0);
  const key = `${sourceId}\u001f${object.schema}\u001f${object.name}\u001f${token}`;
  const [result, setResult] = useState<{ key: string; value: Result } | null>(null);

  useEffect(() => {
    if (!connected) {
      return;
    }
    let cancelled = false;
    backend
      .objectDetails(sourceId, object)
      .then((details) => !cancelled && setResult({ key, value: { details } }))
      .catch(
        (e: unknown) => !cancelled && setResult({ key, value: { error: toAppError(e).message } }),
      );
    return () => {
      cancelled = true;
    };
    // `key` covers the source, the object and the reload token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected]);

  const value = result?.key === key ? result.value : undefined;
  return { connected, value, reload: () => setToken((t) => t + 1) };
}

export function formatBytes(n: number): string {
  const units = ['bytes', 'kB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${n} bytes` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** What fills a column's "Default" cell: its default, generation expression, or identity. */
export function columnDefault(c: ColumnDetail): string {
  if (c.generated) {
    return `GENERATED ALWAYS AS ${c.generated} STORED`;
  }
  if (c.identity) {
    return `GENERATED ${c.identity.toUpperCase()} AS IDENTITY`;
  }
  return c.default ?? '';
}

const qualified = (schema: string, table: string) => `${schema}.${table}`;
const fkTarget = (k: ForeignKeyDetail) =>
  `${qualified(k.toSchema, k.toTable)} (${k.toColumns.join(', ')})`;

/** Read-only structure of a table, view or materialized view (M4.3). */
export function ObjectViewer({
  tabId,
  sourceId,
  object,
}: {
  tabId: string;
  sourceId: string;
  object: ObjectRef;
}) {
  const source = useConnections((s) => s.items.find((c) => c.id === sourceId));
  const { connected, value, reload } = useObjectDetails(sourceId, object);
  const [connectError, setConnectError] = useState<string | null>(null);
  const kind = object.objectType.replace('_', ' ');

  async function connect() {
    if (!source) {
      return;
    }
    setConnectError(null);
    const error = await useSessions.getState().connect(source.id);
    if (error?.connectKind === 'password_required') {
      await askPasswordAndConnect(source);
    } else if (error) {
      setConnectError(error.message);
    }
  }

  let body: ReactNode;
  if (!source) {
    body = <p className="text-muted">This data source no longer exists.</p>;
  } else if (!connected) {
    body = (
      <div className="space-y-2">
        <p className="text-muted">Connect to {source.name} to see the structure.</p>
        <button
          type="button"
          onClick={() => void connect()}
          className="rounded border border-border px-3 py-1 hover:bg-hover"
        >
          Connect
        </button>
        {connectError && (
          <p role="alert" className="text-danger">
            {connectError}
          </p>
        )}
      </div>
    );
  } else if (!value) {
    body = (
      <p role="status" className="text-muted">
        Loading…
      </p>
    );
  } else if ('error' in value) {
    body = (
      <p role="alert" className="text-danger">
        Could not read the structure: {value.error}
      </p>
    );
  } else if (!value.details) {
    body = <p className="text-muted">This {kind} no longer exists. Refresh the explorer.</p>;
  } else {
    body = <Details details={value.details} />;
  }

  return (
    <div
      id="editor-tabpanel"
      role="tabpanel"
      aria-labelledby={`tab-${tabId}`}
      className="min-h-0 flex-1 overflow-auto"
    >
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-mono text-[14px] font-semibold">
            {qualified(object.schema, object.name)}
          </h2>
          <p className="text-muted">
            {kind}
            {source ? ` in ${source.name}` : ''}
            {value && 'details' in value && value.details && <Stats details={value.details} />}
          </p>
          {value && 'details' in value && value.details?.comment && (
            <p className="mt-1">{value.details.comment}</p>
          )}
        </div>
        <button
          type="button"
          onClick={reload}
          disabled={!connected}
          className="flex items-center gap-1 rounded px-2 py-1 hover:bg-hover disabled:opacity-40"
        >
          <RefreshCw size={13} aria-hidden /> Refresh
        </button>
      </header>
      <div className="space-y-5 px-4 py-3 text-[12px]">{body}</div>
    </div>
  );
}

function Stats({ details }: { details: ObjectDetails }) {
  const parts = [
    details.rowEstimate !== undefined && details.rowEstimate !== null
      ? `about ${details.rowEstimate.toLocaleString()} rows`
      : null,
    details.totalBytes !== undefined && details.totalBytes !== null
      ? formatBytes(details.totalBytes)
      : null,
  ].filter(Boolean);
  return parts.length ? <> · {parts.join(' · ')}</> : null;
}

function Section({
  title,
  count,
  columns,
  children,
}: {
  title: string;
  count: number;
  columns: string[];
  children: ReactNode;
}) {
  if (count === 0) {
    return null;
  }
  return (
    <section aria-label={title}>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
        {title} <span className="font-normal">{count}</span>
      </h3>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border text-left text-muted">
            {columns.map((c) => (
              <th key={c} scope="col" className="py-1 pr-4 font-normal">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">{children}</tbody>
      </table>
    </section>
  );
}

const td = 'py-1 pr-4 align-top';

function Details({ details: d }: { details: ObjectDetails }) {
  return (
    <>
      <Section
        title="Columns"
        count={d.columns.length}
        columns={['Name', 'Type', 'Nullable', 'Default', 'Comment']}
      >
        {d.columns.map((c) => (
          <tr key={c.name} className="border-b border-border/50">
            <td className={td}>
              <span className="inline-flex items-center gap-1">
                {c.primaryKey && (
                  <KeyRound size={12} className="text-[#d98a1f]" aria-label="primary key" />
                )}
                {c.name}
              </span>
            </td>
            <td className={td}>{c.typeName}</td>
            <td className={td}>{c.nullable ? 'null' : 'not null'}</td>
            <td className={`${td} break-all`}>{columnDefault(c)}</td>
            <td className={`${td} font-sans`}>{c.comment}</td>
          </tr>
        ))}
      </Section>
      <Section title="Indexes" count={d.indexes.length} columns={['Name', 'Definition', 'Kind']}>
        {d.indexes.map((i) => (
          <tr key={i.name} className="border-b border-border/50">
            <td className={td}>{i.name}</td>
            <td className={`${td} break-all`}>{i.definition}</td>
            <td className={`${td} font-sans`}>
              {i.primary ? 'primary key' : i.unique ? 'unique' : ''}
            </td>
          </tr>
        ))}
      </Section>
      <Section
        title="Constraints"
        count={d.constraints.length}
        columns={['Name', 'Kind', 'Definition']}
      >
        {d.constraints.map((c) => (
          <tr key={c.name} className="border-b border-border/50">
            <td className={td}>{c.name}</td>
            <td className={`${td} font-sans`}>{c.kind}</td>
            <td className={`${td} break-all`}>{c.definition}</td>
          </tr>
        ))}
      </Section>
      <Section
        title="Foreign keys"
        count={d.references.length}
        columns={['Name', 'Columns', 'References', 'On update', 'On delete']}
      >
        {d.references.map((k) => (
          <tr key={k.name} className="border-b border-border/50">
            <td className={td}>{k.name}</td>
            <td className={td}>{k.fromColumns.join(', ')}</td>
            <td className={td}>
              {fkTarget(k)}
              {k.deferrable && <span className="font-sans text-muted"> deferrable</span>}
            </td>
            <td className={`${td} font-sans`}>{k.onUpdate}</td>
            <td className={`${td} font-sans`}>{k.onDelete}</td>
          </tr>
        ))}
      </Section>
      <Section
        title="Referenced by"
        count={d.referencedBy.length}
        columns={['Name', 'From', 'Columns', 'On delete']}
      >
        {d.referencedBy.map((k) => (
          <tr
            key={`${k.fromSchema}.${k.fromTable}.${k.name}`}
            className="border-b border-border/50"
          >
            <td className={td}>{k.name}</td>
            <td className={td}>
              {qualified(k.fromSchema, k.fromTable)} ({k.fromColumns.join(', ')})
            </td>
            <td className={td}>{k.toColumns.join(', ')}</td>
            <td className={`${td} font-sans`}>{k.onDelete}</td>
          </tr>
        ))}
      </Section>
      <Section
        title="Triggers"
        count={d.triggers.length}
        columns={['Name', 'Definition', 'Enabled']}
      >
        {d.triggers.map((t) => (
          <tr key={t.name} className="border-b border-border/50">
            <td className={td}>{t.name}</td>
            <td className={`${td} break-all`}>{t.definition}</td>
            <td className={`${td} font-sans`}>{t.enabled ? 'yes' : 'disabled'}</td>
          </tr>
        ))}
      </Section>
    </>
  );
}
