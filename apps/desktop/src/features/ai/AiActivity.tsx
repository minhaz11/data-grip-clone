import { useEffect, useId, useState } from 'react';
import { askConfirm } from '../../app/dialogs';
import { errorMessage } from '../../app/settingsStore';
import { backend } from '../../ipc/client';
import type { AiConsent, AiLogEntry } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { LEVEL_LABELS } from './ConsentDialog';
import { formatBytes } from './PayloadPreview';

const button = 'rounded border border-border px-2 py-0.5 hover:bg-hover disabled:opacity-50';
const LOG_LIMIT = 200;

const STATUS: Record<AiLogEntry['status'], string> = {
  sent: 'sent',
  done: 'answered',
  failed: 'failed',
  cancelled: 'stopped',
};

/** Settings > AI: what each data source may send, and the local log of what was sent. */
export function AiActivity() {
  const ids = useId();
  const sources = useConnections((s) => s.items);
  const [consents, setConsents] = useState<AiConsent[]>([]);
  const [log, setLog] = useState<AiLogEntry[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let current = true;
    Promise.all([backend.aiConsentsList(), backend.aiLogList(LOG_LIMIT)])
      .then(([c, l]) => {
        if (current) {
          setConsents(c);
          setLog(l);
        }
      })
      .catch((e: unknown) => {
        if (current) {
          setError(errorMessage(e));
        }
      });
    return () => {
      current = false;
    };
  }, [reloads]);

  const reload = () => setReloads((n) => n + 1);
  const nameOf = (id: string) => sources.find((s) => s.id === id)?.name ?? 'Deleted data source';

  async function revoke(consent: AiConsent) {
    setError(null);
    try {
      await backend.aiConsentRevoke(consent.connectionId);
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function clear() {
    const ok = await askConfirm({
      title: 'Clear the AI request log?',
      body: `All ${log.length} entries are removed from this computer.`,
      confirmLabel: 'Clear Log',
      danger: true,
    });
    if (!ok) {
      return;
    }
    setError(null);
    try {
      await backend.aiLogClear();
      setOpen(null);
      reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="space-y-4">
      <section aria-labelledby={`${ids}-consents`} className="space-y-2">
        <h3 id={`${ids}-consents`} className="font-semibold">
          Data sources
        </h3>
        {consents.length === 0 ? (
          <p className="text-[12px] text-muted">
            No data source has an AI context choice yet. You are asked the first time you use AI
            with one.
          </p>
        ) : (
          <ul
            aria-label="AI context per data source"
            className="rounded border border-border bg-bg"
          >
            {consents.map((c) => (
              <li key={c.connectionId} className="flex items-center gap-2 px-2 py-1">
                <span className="flex-1">
                  {nameOf(c.connectionId)}
                  <span className="block text-[12px] text-muted">
                    {LEVEL_LABELS[c.level]}
                    {c.rowsAlways ? ', rows always allowed' : ''}
                    {c.remembered ? '' : ' (until Quarry restarts)'}
                  </span>
                </span>
                <button
                  type="button"
                  className={button}
                  aria-label={`Revoke AI context for ${nameOf(c.connectionId)}`}
                  onClick={() => void revoke(c)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby={`${ids}-log`} className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 id={`${ids}-log`} className="flex-1 font-semibold">
            Request log
          </h3>
          <button type="button" className={button} onClick={reload}>
            Refresh
          </button>
          <button
            type="button"
            className={`${button} text-danger`}
            disabled={log.length === 0}
            onClick={() => void clear()}
          >
            Clear Log
          </button>
        </div>
        <p className="text-[12px] text-muted">
          Every request is kept here exactly as it was sent (your API key is never part of it), on
          this computer only.
        </p>
        {log.length === 0 ? (
          <p className="text-[12px] text-muted">No requests yet.</p>
        ) : (
          <ul aria-label="AI requests" className="rounded border border-border bg-bg">
            {log.map((entry) => (
              <li key={entry.id} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  aria-expanded={open === entry.id}
                  className="flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-hover"
                  onClick={() => setOpen(open === entry.id ? null : entry.id)}
                >
                  <span className="text-[12px] text-muted">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                  <span className="flex-1 truncate">
                    {entry.connectionName}: {entry.action}
                  </span>
                  <span className="text-[12px] text-muted">
                    {LEVEL_LABELS[entry.level]}
                    {entry.rowsSent ? ', rows' : ''} ·{' '}
                    {formatBytes(new TextEncoder().encode(entry.payload).length)} ·{' '}
                    {STATUS[entry.status]}
                  </span>
                </button>
                {open === entry.id && (
                  <div className="space-y-1 px-2 pb-2">
                    <p className="text-[12px] text-muted">Sent:</p>
                    <pre
                      aria-label="Sent request"
                      tabIndex={0}
                      className="max-h-56 overflow-auto rounded border border-border p-2 font-mono text-[12px] whitespace-pre-wrap"
                    >
                      {entry.payload}
                    </pre>
                    {entry.response && (
                      <>
                        <p className="text-[12px] text-muted">
                          Answer
                          {entry.outputTokens !== null
                            ? ` (${entry.inputTokens ?? 0} input, ${entry.outputTokens} output tokens)`
                            : ''}
                          :
                        </p>
                        <pre
                          aria-label="Answer received"
                          tabIndex={0}
                          className="max-h-56 overflow-auto rounded border border-border p-2 font-mono text-[12px] whitespace-pre-wrap"
                        >
                          {entry.response}
                        </pre>
                      </>
                    )}
                    {entry.error && <p className="text-[12px] text-danger">{entry.error}</p>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
