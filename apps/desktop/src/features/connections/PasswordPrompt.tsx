import { useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import type { AppError, ConnectionProfile } from '../../ipc/types';
import { ConnectionResult } from './ConnectionResult';
import { useSessions } from './sessionsStore';

/** Asks for a password the server requires but that is not stored. The value is not saved. */
export function PasswordPrompt({
  profile,
  onClose,
  onConnected,
}: {
  profile: ConnectionProfile;
  onClose(): void;
  /** Called once the session is open, before `onClose`. */
  onConnected?(): void;
}) {
  const connect = useSessions((s) => s.connect);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function submit() {
    setBusy(true);
    const err = await connect(profile.id, password);
    setBusy(false);
    if (err) setError(err);
    else {
      onConnected?.();
      onClose();
    }
  }

  return (
    <Modal
      title={`Connect to ${profile.name}`}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <label className="block">
          <span className="mb-1 block">
            Password for <strong>{profile.username}</strong>@{profile.host}
          </span>
          <input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-border bg-bg px-2 py-1"
          />
        </label>
        <p className="text-muted">
          Used for this connection only. To save it, edit the data source.
        </p>
        {error && <ConnectionResult result={{ error }} />}
      </form>
    </Modal>
  );
}
