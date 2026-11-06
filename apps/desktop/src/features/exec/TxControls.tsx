import { useEffect, useState } from 'react';
import { useWorkspace, type ConsoleTab } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { Isolation, TxMode, TxSettings } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { useConnections } from '../connections/connectionsStore';
import { useSessions } from '../connections/sessionsStore';
import { useMetadata } from '../explorer/metadataStore';
import { isRunning, useExec } from './execStore';
import { setOwnSession } from './txGuards';
import { keyOf, sessionOf, useTx } from './txStore';

/** After Stop, how long to wait before offering to drop the connection. */
export const DROP_AFTER_MS = 3000;

const ISOLATIONS: { value: Isolation; label: string }[] = [
  { value: 'read_committed', label: 'Read committed' },
  { value: 'repeatable_read', label: 'Repeatable read' },
  { value: 'serializable', label: 'Serializable' },
];

const select = 'rounded border border-border bg-bg px-1.5 py-0.5';

/**
 * Session, schema and transaction controls for one console (REQ-TX-01, REQ-SESS-01). Commit and
 * Rollback show in Manual mode or whenever a transaction is open (e.g. after a typed BEGIN).
 */
export function TxControls({ tab }: { tab: ConsoleTab }) {
  const source = useConnections((s) => s.items.find((c) => c.id === tab.sourceId));
  const connected = useSessions((s) =>
    tab.sourceId ? s.byId[tab.sourceId]?.state === 'connected' : false,
  );
  const session = sessionOf(tab);
  const key = session ? keyOf(session) : null;
  const state = useTx((s) => (key ? s.states[key] : undefined));
  const running = useExec((s) => isRunning(s.runs[tab.id]));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (session && connected) {
      void useTx
        .getState()
        .load(session)
        .catch(() => {});
    }
    // `key` identifies `session`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected]);

  if (!source || !session) {
    return null;
  }
  const settings: TxSettings = state?.settings ?? {
    mode: source.txMode,
    isolation: source.isolation,
  };
  const status = state?.open ? state.status : 'idle';
  const showEnd = settings.mode === 'manual' || status !== 'idle';

  async function act(f: () => Promise<void>) {
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(toAppError(e).message);
    }
  }
  const tx = useTx.getState();
  const changeSettings = (next: TxSettings) => void act(() => tx.setSettings(session, next));

  return (
    <>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <label className="flex items-center gap-1.5">
        <span className="text-muted">Session</span>
        <select
          value={tab.ownSession ? 'own' : 'shared'}
          onChange={(e) => void setOwnSession(tab.id, e.target.value === 'own')}
          disabled={running}
          className={select}
          title="Shared: one connection and transaction for every console of this data source. Own: this console gets its own."
        >
          <option value="shared">Shared</option>
          <option value="own">Own</option>
        </select>
      </label>
      <SchemaPicker tab={tab} connected={connected} />
      <label className="flex items-center gap-1.5">
        <span className="text-muted">Tx</span>
        <select
          value={settings.mode}
          onChange={(e) => changeSettings({ ...settings, mode: e.target.value as TxMode })}
          className={select}
          title="Auto: each statement commits. Manual: changes stay in an open transaction until Commit."
        >
          <option value="auto">Auto</option>
          <option value="manual">Manual</option>
        </select>
      </label>
      {settings.mode === 'manual' && (
        <select
          aria-label="Isolation level"
          value={settings.isolation}
          onChange={(e) => changeSettings({ ...settings, isolation: e.target.value as Isolation })}
          className={select}
        >
          {ISOLATIONS.map((i) => (
            <option key={i.value} value={i.value}>
              {i.label}
            </option>
          ))}
        </select>
      )}
      {status !== 'idle' && (
        <span
          role="status"
          className={
            status === 'failed'
              ? 'rounded bg-danger px-1.5 text-danger-fg'
              : 'rounded bg-accent px-1.5 text-accent-fg'
          }
        >
          {status === 'failed' ? 'Transaction failed: roll back' : 'Transaction open'}
        </span>
      )}
      {showEnd && (
        <>
          <button
            type="button"
            onClick={() => void act(() => tx.commit(session))}
            disabled={running || status !== 'active'}
            className="rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-40"
          >
            Commit
          </button>
          <button
            type="button"
            onClick={() => void act(() => tx.rollback(session))}
            disabled={running || status === 'idle'}
            className="rounded px-1.5 py-0.5 text-danger hover:bg-hover disabled:opacity-40"
          >
            Rollback
          </button>
        </>
      )}
      <DropConnection tabId={tab.id} />
      {error && (
        <span role="alert" className="min-w-0 truncate text-danger" title={error}>
          {error}
        </span>
      )}
    </>
  );
}

/** The console's schema: put first in the search path for its runs. */
function SchemaPicker({ tab, connected }: { tab: ConsoleTab; connected: boolean }) {
  const setSchema = useWorkspace((s) => s.setSchema);
  const loaded = useMetadata((s) => (tab.sourceId ? s.children[tab.sourceId] : undefined));
  const schemas =
    loaded?.status === 'loaded'
      ? loaded.nodes.filter((n) => n.kind === 'schema').map((n) => n.name)
      : [];
  if (tab.schema && !schemas.includes(tab.schema)) {
    schemas.unshift(tab.schema);
  }
  const load = () => {
    if (tab.sourceId && connected && !loaded) {
      void useMetadata.getState().load(tab.sourceId, tab.sourceId, { level: 'schemas' });
    }
  };
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-muted">Schema</span>
      <select
        value={tab.schema ?? ''}
        onFocus={load}
        onPointerDown={load}
        onChange={(e) => setSchema(tab.id, e.target.value || null)}
        className={`${select} max-w-36`}
        title="Searched first for unqualified names in this console's statements"
      >
        <option value="">Default</option>
        {schemas.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Second-stage cancel: when Stop has not ended the statement, offer to drop the connection. */
function DropConnection({ tabId }: { tabId: string }) {
  const run = useExec((s) => s.runs[tabId]);
  const [now, setNow] = useState(() => Date.now());
  const waiting = isRunning(run) && run?.cancelRequestedAt !== undefined;
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [waiting]);
  if (!waiting || !run || now - (run.cancelRequestedAt ?? now) < DROP_AFTER_MS) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={() => void backend.sessionDrop(run.session).catch(() => {})}
      className="rounded border border-danger px-1.5 py-0.5 text-danger hover:bg-hover"
      title="The statement did not stop. Dropping the connection ends this session at once; the server may still finish the statement."
    >
      Drop connection
    </button>
  );
}
