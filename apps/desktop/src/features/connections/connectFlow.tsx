import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { askCustom } from '../../app/dialogs';
import { Modal } from '../../components/ui/Modal';
import { backend } from '../../ipc/client';
import type { AppError, ConnectionProfile, HostKeyPrompt } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { ConnectionResult } from './ConnectionResult';
import { useConnections } from './connectionsStore';
import { useSessions } from './sessionsStore';

/** Connected; or not, with the error to show (`null` when the user cancelled a prompt). */
export type ConnectOutcome = { ok: true } | { ok: false; error: AppError | null };

/** Errors the flow resolves by asking the user something and trying again. */
const PROMPTED = new Set([
  'password_required',
  'ssh_secret_required',
  'ssh_host_unknown',
  'ssh_host_changed',
]);

/**
 * Connects a data source, asking for whatever the attempt needs: the database password, the SSH
 * password or key passphrase, or trust in the SSH server's host key. Secrets typed here are used
 * for this connection only; nothing is saved.
 */
export async function connectSource(profile: ConnectionProfile): Promise<ConnectOutcome> {
  const connect = useSessions.getState().connect;
  let password: string | undefined;
  let sshSecret: string | undefined;
  // The secret prompted last: a following authentication failure asks for it again.
  let asked: 'db' | 'ssh' | null = null;
  let error = await connect(profile.id, password, sshSecret);
  // Bounded, so a server that keeps changing its answer cannot loop forever.
  for (let round = 0; error && round < 8; round++) {
    const kind = error.connectKind;
    const retry = kind === 'auth' && asked !== null;
    if (!PROMPTED.has(kind ?? '') && !retry) {
      break;
    }
    if (kind === 'ssh_host_unknown' || kind === 'ssh_host_changed') {
      if (!error.hostKey || !(await askTrustHostKey(profile, error.hostKey, error))) {
        return { ok: false, error: null };
      }
    } else if (kind === 'ssh_secret_required' || (retry && asked === 'ssh')) {
      const value = await askSecret(profile, 'ssh', retry ? error : null);
      if (value === null) {
        return { ok: false, error: null };
      }
      sshSecret = value;
      asked = 'ssh';
    } else {
      const value = await askSecret(profile, 'db', retry ? error : null);
      if (value === null) {
        return { ok: false, error: null };
      }
      password = value;
      asked = 'db';
    }
    error = await connect(profile.id, password, sshSecret);
  }
  return error ? { ok: false, error } : { ok: true };
}

function sshProfileOf(profile: ConnectionProfile) {
  return useConnections.getState().sshProfiles.find((p) => p.id === profile.sshProfileId);
}

function askSecret(
  profile: ConnectionProfile,
  what: 'db' | 'ssh',
  error: AppError | null,
): Promise<string | null> {
  const ssh = what === 'ssh' ? sshProfileOf(profile) : undefined;
  let label = `Password for ${profile.username}@${profile.host}`;
  if (what === 'ssh') {
    label =
      ssh?.auth === 'key'
        ? `Passphrase for SSH key ${ssh.keyFile ?? ''}`
        : `SSH password for ${ssh?.username ?? ''}@${ssh?.host ?? 'the SSH server'}`;
  }
  return askCustom<string>((done) => (
    <SecretPrompt
      title={`Connect to ${profile.name}`}
      label={label}
      error={error}
      onSubmit={(value) => done(value)}
      onCancel={() => done(null)}
    />
  ));
}

/** Asks for one secret. The value is used for this connection only. */
export function SecretPrompt({
  title,
  label,
  error,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  /** The previous attempt's failure, shown above the field. */
  error: AppError | null;
  onSubmit(value: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState('');
  return (
    <Modal
      title={title}
      onClose={onCancel}
      initialFocus="input[type=password]"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(value)}
            className="rounded bg-accent px-3 py-1 text-accent-fg"
          >
            Connect
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value);
        }}
        className="space-y-3"
      >
        {error && <ConnectionResult result={{ error }} />}
        <label className="block">
          <span className="mb-1 block break-all">{label}</span>
          <input
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded border border-border bg-bg px-2 py-1"
          />
        </label>
        <p className="text-muted">
          Used for this connection only. To save it, edit the data source.
        </p>
      </form>
    </Modal>
  );
}

/** Shows the SSH server's host key; resolves true once the user trusted it. */
async function askTrustHostKey(
  profile: ConnectionProfile,
  key: HostKeyPrompt,
  error: AppError,
): Promise<boolean> {
  const trusted = await askCustom<boolean>((done) => (
    <HostKeyDialog
      sourceName={profile.name}
      hostKey={key}
      hint={error.hint ?? null}
      onTrust={async () => {
        await backend.sshHostTrust(key.host, key.port, key.fingerprint);
        done(true);
      }}
      onCancel={() => done(null)}
    />
  ));
  return trusted === true;
}

export function HostKeyDialog({
  sourceName,
  hostKey,
  hint,
  onTrust,
  onCancel,
}: {
  sourceName: string;
  hostKey: HostKeyPrompt;
  hint: string | null;
  onTrust(): Promise<void>;
  onCancel(): void;
}) {
  const changed = hostKey.expected !== undefined;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<AppError | null>(null);
  return (
    <Modal
      title={changed ? 'SSH Host Key Changed' : 'Trust SSH Host?'}
      onClose={onCancel}
      width={520}
      // Cancel is the safe default, above all when the key changed.
      initialFocus="[data-autofocus]"
      footer={
        <>
          <button
            type="button"
            data-autofocus
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onTrust();
              } catch (e) {
                setFailure(toAppError(e));
                setBusy(false);
              }
            }}
            className={`rounded px-3 py-1 disabled:opacity-50 ${
              changed ? 'bg-danger text-danger-fg' : 'bg-accent text-accent-fg'
            }`}
          >
            {changed ? 'Trust New Key and Connect' : 'Trust and Connect'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {changed ? (
          <p className="flex items-start gap-2 text-danger">
            <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              The SSH server for <strong>{sourceName}</strong> presented a different host key than
              the one trusted before.
            </span>
          </p>
        ) : (
          <p>
            Quarry has not connected to this SSH server before. Check that the fingerprint matches
            the server&apos;s before you trust it.
          </p>
        )}
        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted">Server</dt>
          <dd className="break-all">
            {hostKey.host}:{hostKey.port}
          </dd>
          <dt className="text-muted">Key type</dt>
          <dd>{hostKey.algorithm}</dd>
          <dt className="text-muted">Fingerprint</dt>
          <dd className="select-text break-all font-mono text-[12px]">{hostKey.fingerprint}</dd>
          {changed && (
            <>
              <dt className="text-muted">Trusted before</dt>
              <dd className="select-text break-all font-mono text-[12px]">{hostKey.expected}</dd>
            </>
          )}
        </dl>
        {hint && <p className="text-muted">{hint}</p>}
        {failure && <ConnectionResult result={{ error: failure }} />}
      </div>
    </Modal>
  );
}
