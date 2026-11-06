import clsx from 'clsx';
import { CheckCircle2, Circle, XCircle } from 'lucide-react';
import { useState } from 'react';
import { backend } from '../../ipc/client';
import type { AppError, ConnectErrorKind, ConnectionProfile, ServerInfo } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { ConnectionResult } from './ConnectionResult';
import { draftOf } from './model';

interface Check {
  key: 'ssh' | 'reach' | 'credentials' | 'tls';
  label: string;
  detail: string;
}

/** In the order a connection attempt goes through them. */
const CHECKS: Check[] = [
  {
    key: 'ssh',
    label: 'SSH tunnel',
    detail: 'SSH host and port, user, password or key, trusted host key, TCP forwarding',
  },
  {
    key: 'reach',
    label: 'Server reachable',
    detail: 'Host and port, network or VPN, firewall, server running',
  },
  // TLS is negotiated before the server checks credentials.
  { key: 'tls', label: 'TLS', detail: 'SSL mode, CA file, client certificate and key' },
  {
    key: 'credentials',
    label: 'Credentials accepted',
    detail: 'User, password, database name',
  },
];

/** Which check an error belongs to (`null` when it fits none of them). */
export function failedCheck(e: AppError): Check['key'] | null {
  if (e.tunnel || e.connectKind?.startsWith('ssh')) {
    return 'ssh';
  }
  const byKind: Partial<Record<ConnectErrorKind, Check['key']>> = {
    dns: 'reach',
    refused: 'reach',
    timeout: 'reach',
    server_unavailable: 'reach',
    auth: 'credentials',
    password_required: 'credentials',
    database_missing: 'credentials',
    tls: 'tls',
  };
  return (e.connectKind && byKind[e.connectKind]) ?? null;
}

/**
 * Why a data source did not connect: the error, a short checklist that points at the failing
 * step, and Test Connection / Edit / Connect to act on it.
 */
export function ConnectFailure({
  profile,
  error,
  onEdit,
  onConnect,
  onDismiss,
}: {
  profile: ConnectionProfile;
  error: AppError;
  onEdit(): void;
  onConnect(): void;
  onDismiss(): void;
}) {
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: ServerInfo } | { error: AppError } | null>(null);
  const shown = test && 'error' in test ? test.error : error;
  const passed = test !== null && 'ok' in test;
  const failed = passed ? null : failedCheck(shown);
  const checks = CHECKS.filter((c) => c.key !== 'ssh' || profile.sshProfileId);
  const failedAt = checks.findIndex((c) => c.key === failed);

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest({ ok: await backend.connectionTest(draftOf(profile), profile.id, null, null) });
    } catch (e) {
      setTest({ error: toAppError(e) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-2 border-b border-border p-2" aria-label={`${profile.name} failed`}>
      <p className="flex items-center justify-between text-[11px] text-muted">
        <span>{profile.name}</span>
        <button type="button" className="underline" onClick={onDismiss}>
          Dismiss
        </button>
      </p>
      <ConnectionResult result={test ?? { error }} />
      <ul aria-label="Connection checklist" className="space-y-0.5 text-[12px]">
        {checks.map((c, i) => {
          // Steps before the failing one passed; later ones were not reached.
          const state =
            passed || (failedAt >= 0 && i < failedAt)
              ? 'ok'
              : i === failedAt
                ? 'failed'
                : 'unknown';
          const Icon = state === 'ok' ? CheckCircle2 : state === 'failed' ? XCircle : Circle;
          return (
            <li key={c.key} className="flex items-start gap-1.5">
              <Icon
                size={13}
                aria-hidden
                className={clsx(
                  'mt-0.5 shrink-0',
                  state === 'ok' && 'text-success',
                  state === 'failed' && 'text-danger',
                  state === 'unknown' && 'text-muted',
                )}
              />
              <span>
                <span className={clsx(state === 'failed' && 'font-medium text-danger')}>
                  {c.label}
                </span>
                <span className="sr-only">
                  {state === 'ok' ? ': passed' : state === 'failed' ? ': failed' : ': not checked'}
                </span>
                <span className="block text-muted">{c.detail}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void runTest()}
          disabled={testing}
          className="rounded border border-border px-2 py-0.5 hover:bg-hover disabled:opacity-50"
        >
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="rounded border border-border px-2 py-0.5 hover:bg-hover"
        >
          Edit Data Source…
        </button>
        <button
          type="button"
          onClick={onConnect}
          className="rounded border border-border px-2 py-0.5 hover:bg-hover"
        >
          Connect
        </button>
      </div>
    </div>
  );
}
