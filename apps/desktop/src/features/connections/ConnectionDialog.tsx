import { useId, useState, type ReactNode } from 'react';
import { Modal } from '../../components/ui/Modal';
import type {
  ConnectionDraft,
  ConnectionProfile,
  Isolation,
  PasswordChange,
  SaveMode,
  SslMode,
  TxMode,
} from '../../ipc/types';
import { backend } from '../../ipc/client';
import type { AppError, ServerInfo } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { ConnectionResult } from './ConnectionResult';
import { useConnections } from './connectionsStore';
import { ENVIRONMENTS, NEW_DRAFT, effectiveColor, validateDraft, type DraftErrors } from './model';

const SAVE_MODES: { value: SaveMode; label: string }[] = [
  { value: 'forever', label: 'Forever (system keyring)' },
  { value: 'untilRestart', label: 'Until app restart' },
  { value: 'never', label: 'Never (ask on connect)' },
];

const SSL_MODES: { value: SslMode; label: string }[] = [
  { value: 'disable', label: 'Disable' },
  { value: 'prefer', label: 'Prefer' },
  { value: 'require', label: 'Require' },
  { value: 'verify-ca', label: 'Verify CA' },
  { value: 'verify-full', label: 'Verify full' },
];

const field = 'rounded border border-border bg-bg px-2 py-1 aria-[invalid=true]:border-danger';
const input = `${field} w-full`;

function draftOf(p: ConnectionProfile): ConnectionDraft {
  const { id: _id, passwordSaved: _p, createdAt: _c, updatedAt: _u, ...draft } = p;
  return draft;
}

interface Props {
  /** Existing profile to edit; omit to create a new data source. */
  profile?: ConnectionProfile;
  onClose(): void;
}

export function ConnectionDialog({ profile, onClose }: Props) {
  const create = useConnections((s) => s.create);
  const update = useConnections((s) => s.update);
  const [draft, setDraft] = useState<ConnectionDraft>(profile ? draftOf(profile) : NEW_DRAFT);
  const [password, setPassword] = useState('');
  // Editing a profile with a saved password: keep it unless the user explicitly changes or clears it.
  const [passwordAction, setPasswordAction] = useState<'keep' | 'set' | 'clear'>(
    profile?.passwordSaved ? 'keep' : 'set',
  );
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: ServerInfo } | { error: AppError } | null>(
    null,
  );

  const errors: DraftErrors = submitted ? validateDraft(draft) : {};
  const patch = (p: Partial<ConnectionDraft>) => setDraft((d) => ({ ...d, ...p }));
  const marker = effectiveColor(draft);

  /** Tests the form as it is now (saved or not). A typed password wins over the stored one. */
  async function test() {
    setSubmitted(true);
    if (Object.keys(validateDraft(draft)).length > 0) return;
    setTesting(true);
    setTestResult(null);
    const typed = passwordAction === 'set' && password !== '' ? password : null;
    const reuseStoredFor =
      profile && passwordAction === 'keep' && draft.saveMode !== 'never' ? profile.id : null;
    try {
      setTestResult({ ok: await backend.connectionTest(draft, reuseStoredFor, typed) });
    } catch (e) {
      setTestResult({ error: toAppError(e) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSubmitted(true);
    if (Object.keys(validateDraft(draft)).length > 0) return;
    setBusy(true);
    setServerError(null);
    try {
      const storesPassword = draft.saveMode !== 'never';
      if (profile) {
        let change: PasswordChange = { action: 'keep' };
        if (storesPassword && passwordAction === 'clear') change = { action: 'clear' };
        if (storesPassword && passwordAction === 'set' && password !== '')
          change = { action: 'set', value: password };
        await update(profile.id, draft, change);
      } else {
        await create(draft, storesPassword && password !== '' ? password : null);
      }
      setPassword('');
      onClose();
    } catch (e) {
      setServerError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={profile ? `Data Source: ${profile.name}` : 'New PostgreSQL Data Source'}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button
            type="button"
            onClick={test}
            disabled={testing || busy}
            className="mr-auto rounded border border-border px-3 py-1 hover:bg-hover disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <form
        className="grid grid-cols-[130px_1fr] items-start gap-x-3 gap-y-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label="Name" error={errors.name}>
          {(id, describedBy) => (
            <input
              id={id}
              className={input}
              value={draft.name}
              aria-invalid={!!errors.name}
              aria-describedby={describedBy}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="e.g. Orders (local)"
            />
          )}
        </Field>

        <Field label="Environment">
          {(id) => (
            <div className="flex items-center gap-2">
              <select
                id={id}
                className={input}
                value={draft.environment}
                onChange={(e) =>
                  patch({ environment: e.target.value as ConnectionDraft['environment'] })
                }
              >
                {ENVIRONMENTS.map((env) => (
                  <option key={env.value} value={env.value}>
                    {env.label}
                  </option>
                ))}
              </select>
              <input
                type="color"
                aria-label="Color"
                title="Color"
                value={marker ?? '#888888'}
                onChange={(e) => patch({ color: e.target.value })}
                className="h-7 w-9 shrink-0 cursor-pointer rounded border border-border bg-bg"
              />
              {draft.color && (
                <button
                  type="button"
                  onClick={() => patch({ color: null })}
                  className="shrink-0 text-[12px] text-muted underline"
                >
                  Reset
                </button>
              )}
            </div>
          )}
        </Field>

        <Field label="Host" error={errors.host ?? errors.port}>
          {(id, describedBy) => (
            <div className="flex gap-2">
              <input
                id={id}
                className={input}
                value={draft.host}
                aria-invalid={!!errors.host}
                aria-describedby={describedBy}
                onChange={(e) => patch({ host: e.target.value })}
              />
              <input
                aria-label="Port"
                type="number"
                min={1}
                max={65535}
                className={`${field} w-24 shrink-0`}
                value={Number.isNaN(draft.port) ? '' : draft.port}
                aria-invalid={!!errors.port}
                onChange={(e) => patch({ port: e.target.valueAsNumber })}
              />
            </div>
          )}
        </Field>

        <Field label="Database">
          {(id) => (
            <input
              id={id}
              className={input}
              value={draft.database}
              onChange={(e) => patch({ database: e.target.value })}
            />
          )}
        </Field>

        <Field label="User" error={errors.username}>
          {(id, describedBy) => (
            <input
              id={id}
              className={input}
              value={draft.username}
              autoComplete="off"
              aria-invalid={!!errors.username}
              aria-describedby={describedBy}
              onChange={(e) => patch({ username: e.target.value })}
            />
          )}
        </Field>

        <Field label="Save password">
          {(id) => (
            <select
              id={id}
              className={input}
              value={draft.saveMode}
              onChange={(e) => patch({ saveMode: e.target.value as SaveMode })}
            >
              {SAVE_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Password">
          {(id) =>
            draft.saveMode === 'never' ? (
              <div>
                <input
                  id={id}
                  type="password"
                  className={input}
                  value={password}
                  autoComplete="off"
                  placeholder="For Test Connection only"
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setPasswordAction('set');
                  }}
                />
                <p className="mt-0.5 text-[12px] text-muted">
                  Not stored. You will be asked for it when connecting.
                </p>
              </div>
            ) : passwordAction === 'keep' ? (
              <div id={id} className="flex items-center gap-3 py-1">
                <span className="text-muted">Saved</span>
                <button
                  type="button"
                  className="text-accent underline"
                  onClick={() => setPasswordAction('set')}
                >
                  Change…
                </button>
                <button
                  type="button"
                  className="text-danger underline"
                  onClick={() => setPasswordAction('clear')}
                >
                  Clear
                </button>
              </div>
            ) : passwordAction === 'clear' ? (
              <div id={id} className="flex items-center gap-3 py-1">
                <span className="text-danger">Will be removed on save</span>
                <button
                  type="button"
                  className="text-accent underline"
                  onClick={() => setPasswordAction('keep')}
                >
                  Undo
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <input
                  id={id}
                  type="password"
                  className={input}
                  value={password}
                  autoComplete="new-password"
                  placeholder={profile?.passwordSaved ? 'New password' : 'Optional'}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {profile?.passwordSaved && (
                  <button
                    type="button"
                    className="shrink-0 text-accent underline"
                    onClick={() => {
                      setPassword('');
                      setPasswordAction('keep');
                    }}
                  >
                    Keep saved
                  </button>
                )}
              </div>
            )
          }
        </Field>

        <Field label="SSL mode">
          {(id) => (
            <select
              id={id}
              className={input}
              value={draft.sslMode}
              onChange={(e) => patch({ sslMode: e.target.value as SslMode })}
            >
              {SSL_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field label="Connect timeout" error={errors.connectTimeoutSecs}>
          {(id, describedBy) => (
            <div className="flex items-center gap-2">
              <input
                id={id}
                type="number"
                min={1}
                max={300}
                className={`${field} w-24 shrink-0`}
                aria-describedby={describedBy}
                aria-invalid={!!errors.connectTimeoutSecs}
                value={Number.isNaN(draft.connectTimeoutSecs) ? '' : draft.connectTimeoutSecs}
                onChange={(e) => patch({ connectTimeoutSecs: e.target.valueAsNumber })}
              />
              <span className="text-muted">seconds</span>
            </div>
          )}
        </Field>

        <Field label="Transactions">
          {(id) => (
            <select
              id={id}
              className={input}
              value={draft.txMode}
              onChange={(e) => patch({ txMode: e.target.value as TxMode })}
            >
              <option value="auto">Auto-commit each statement</option>
              <option value="manual">Manual: commit or roll back explicitly</option>
            </select>
          )}
        </Field>

        <Field label="Isolation">
          {(id) => (
            <select
              id={id}
              className={input}
              value={draft.isolation}
              onChange={(e) => patch({ isolation: e.target.value as Isolation })}
            >
              <option value="read_committed">Read committed</option>
              <option value="repeatable_read">Repeatable read</option>
              <option value="serializable">Serializable</option>
            </select>
          )}
        </Field>

        <span />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.readOnly}
            onChange={(e) => patch({ readOnly: e.target.checked })}
          />
          Read-only (block statements that modify data or schema)
        </label>

        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
      {testResult && (
        <div className="mt-3">
          <ConnectionResult result={testResult} />
        </div>
      )}
      {serverError && (
        <p role="alert" className="mt-3 text-danger">
          {serverError}
        </p>
      )}
    </Modal>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children(id: string, describedBy?: string): ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <>
      <label htmlFor={id} className="pt-1">
        {label}
      </label>
      <div>
        {children(id, error ? errorId : undefined)}
        {error && (
          <p id={errorId} className="mt-0.5 text-[12px] text-danger">
            {error}
          </p>
        )}
      </div>
    </>
  );
}
