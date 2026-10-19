import { CheckCircle2, Copy, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { AppError, ServerInfo } from '../../ipc/types';
import { errorDetails, errorTitle } from '../../lib/errors';

/** Outcome of a test/connect attempt: server details on success, a categorized error otherwise. */
export function ConnectionResult({ result }: { result: { ok: ServerInfo } | { error: AppError } }) {
  const [copied, setCopied] = useState(false);

  if ('ok' in result) {
    const i = result.ok;
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded border border-border bg-panel-2 px-3 py-2"
      >
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[#3f9d5a]" aria-hidden />
        <div>
          <p className="font-medium">Connected — PostgreSQL {i.serverVersion}</p>
          <p className="text-muted">
            {i.user}@{i.database} · TLS {i.tls ? 'on' : 'off'}
            {i.readOnly ? ' · read-only' : ''} · {i.latencyMs} ms
          </p>
        </div>
      </div>
    );
  }

  const e = result.error;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded border border-danger/50 bg-panel-2 px-3 py-2"
    >
      <XCircle size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
      <div className="min-w-0 flex-1 select-text">
        <p className="font-medium text-danger">{errorTitle(e)}</p>
        <p className="break-words">{e.message}</p>
        {e.hint && <p className="mt-1 text-muted">{e.hint}</p>}
        {e.sqlstate && (
          <p className="mt-1 font-mono text-[11px] text-muted">SQLSTATE {e.sqlstate}</p>
        )}
      </div>
      <button
        type="button"
        title="Copy details"
        aria-label="Copy error details"
        onClick={() => {
          void navigator.clipboard?.writeText(errorDetails(e)).then(() => setCopied(true));
        }}
        className="shrink-0 rounded p-1 text-muted hover:bg-hover hover:text-fg"
      >
        {copied ? <span className="text-[11px]">Copied</span> : <Copy size={14} aria-hidden />}
      </button>
    </div>
  );
}
