import type {
  ConnectionDraft,
  PasswordChange,
  SaveMode,
  SshAuthMethod,
  SshProfile,
  SshProfileDraft,
} from '../../ipc/types';
import { Field, input, NumberInput, PathField } from './fields';
import { isAbsolutePath } from './model';

/** The SSH tab as edited: whether to tunnel, through which profile, and the typed secret. */
export interface SshState {
  enabled: boolean;
  /** The saved profile being used or edited; `null` creates a new one on save. */
  profileId: string | null;
  draft: SshProfileDraft;
  secret: string;
  /** Like the database password: keep the stored secret, set a new one, or clear it. */
  secretAction: 'keep' | 'set' | 'clear';
}

export const NEW_SSH: SshProfileDraft = {
  name: '',
  host: '',
  port: 22,
  username: '',
  auth: 'key',
  keyFile: null,
  saveMode: 'forever',
};

const AUTH_METHODS: { value: SshAuthMethod; label: string }[] = [
  { value: 'key', label: 'Key pair' },
  { value: 'password', label: 'Password' },
  { value: 'agent', label: 'SSH agent' },
];

const SAVE_MODES: { value: SaveMode; label: string }[] = [
  { value: 'forever', label: 'Forever (system keyring)' },
  { value: 'untilRestart', label: 'Until app restart' },
  { value: 'never', label: 'Never (ask on connect)' },
];

function draftOfProfile(p: SshProfile): SshProfileDraft {
  const { id: _id, secretSaved: _s, createdAt: _c, updatedAt: _u, ...draft } = p;
  return draft;
}

export function sshStateFor(profile: SshProfile | undefined): SshState {
  if (!profile) {
    return { enabled: false, profileId: null, draft: NEW_SSH, secret: '', secretAction: 'set' };
  }
  return {
    enabled: true,
    profileId: profile.id,
    draft: draftOfProfile(profile),
    secret: '',
    secretAction: profile.secretSaved ? 'keep' : 'set',
  };
}

export type SshErrors = Partial<Record<keyof SshProfileDraft, string>>;

/** Client-side mirror of `SshProfileDraft::normalized`. */
export function validateSsh(s: SshState): SshErrors {
  const errors: SshErrors = {};
  if (!s.enabled) {
    return errors;
  }
  const d = s.draft;
  if (!d.host.trim() || /\s/.test(d.host.trim())) {
    errors.host = 'SSH host must be a hostname or IP address without spaces.';
  }
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
    errors.port = 'SSH port must be between 1 and 65535.';
  }
  if (!d.username.trim()) {
    errors.username = 'SSH user is required.';
  }
  if (d.auth === 'key' && !d.keyFile?.trim()) {
    errors.keyFile = 'Choose a private key file.';
  } else if (d.auth === 'key' && !isAbsolutePath(d.keyFile?.trim() ?? '')) {
    errors.keyFile = 'Use an absolute file path.';
  }
  return errors;
}

/** The profile as it will be saved: a name is derived from user and host when left empty. */
export function sshDraftToSave(s: SshState): SshProfileDraft {
  const d = s.draft;
  return {
    ...d,
    name: d.name.trim() || `${d.username.trim()}@${d.host.trim()}`,
    keyFile: d.auth === 'key' ? d.keyFile : null,
  };
}

/** What to do with the stored secret on save. */
export function sshSecretChange(s: SshState): PasswordChange {
  if (s.draft.saveMode === 'never' || s.draft.auth === 'agent') {
    return { action: 'clear' };
  }
  if (s.secretAction === 'clear') {
    return { action: 'clear' };
  }
  if (s.secretAction === 'set' && s.secret !== '') {
    return { action: 'set', value: s.secret };
  }
  return { action: 'keep' };
}

export function SshTab({
  state,
  profiles,
  sources,
  editingId,
  errors,
  onChange,
  onError,
}: {
  state: SshState;
  profiles: SshProfile[];
  /** Every data source, to say who else uses the chosen profile. */
  sources: { id: string; name: string; sshProfileId: ConnectionDraft['sshProfileId'] }[];
  /** The data source being edited, if it is saved. */
  editingId: string | null;
  errors: SshErrors;
  onChange(next: SshState): void;
  onError(message: string): void;
}) {
  const d = state.draft;
  const patch = (p: Partial<SshProfileDraft>) =>
    onChange({ ...state, draft: { ...state.draft, ...p } });
  const saved = profiles.find((p) => p.id === state.profileId);
  const others = sources.filter(
    (s) => s.sshProfileId !== null && s.sshProfileId === state.profileId && s.id !== editingId,
  );
  const needsSecret = d.auth !== 'agent';
  const secretLabel = d.auth === 'key' ? 'Key passphrase' : 'Password';

  return (
    <div className="grid grid-cols-[130px_1fr] items-start gap-x-3 gap-y-2.5">
      <span />
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={state.enabled}
          onChange={(e) => onChange({ ...state, enabled: e.target.checked })}
        />
        Connect through an SSH tunnel
      </label>

      {state.enabled && (
        <>
          <Field label="SSH profile">
            {(id) => (
              <select
                id={id}
                className={input}
                value={state.profileId ?? ''}
                onChange={(e) => {
                  const picked = profiles.find((p) => p.id === e.target.value);
                  onChange(
                    picked ? sshStateFor(picked) : { ...sshStateFor(undefined), enabled: true },
                  );
                }}
              >
                <option value="">New SSH profile</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {others.length > 0 && (
            <>
              <span />
              <p className="text-[12px] text-muted">
                Also used by {others.map((o) => o.name).join(', ')}. Changes here apply to them too.
              </p>
            </>
          )}

          <Field label="Profile name">
            {(id) => (
              <input
                id={id}
                className={input}
                value={d.name}
                placeholder={d.username || d.host ? `${d.username}@${d.host}` : 'e.g. Bastion'}
                onChange={(e) => patch({ name: e.target.value })}
              />
            )}
          </Field>

          <Field label="SSH host" error={errors.host ?? errors.port}>
            {(id, describedBy) => (
              <div className="flex gap-2">
                <input
                  id={id}
                  className={input}
                  value={d.host}
                  spellCheck={false}
                  aria-invalid={!!errors.host}
                  aria-describedby={describedBy}
                  onChange={(e) => patch({ host: e.target.value })}
                />
                <NumberInput
                  id={`${id}-port`}
                  label="SSH port"
                  value={d.port}
                  min={1}
                  max={65535}
                  invalid={!!errors.port}
                  onChange={(port) => patch({ port })}
                />
              </div>
            )}
          </Field>

          <Field label="SSH user" error={errors.username}>
            {(id, describedBy) => (
              <input
                id={id}
                className={input}
                value={d.username}
                autoComplete="off"
                aria-invalid={!!errors.username}
                aria-describedby={describedBy}
                onChange={(e) => patch({ username: e.target.value })}
              />
            )}
          </Field>

          <Field label="Authentication">
            {(id) => (
              <select
                id={id}
                className={input}
                value={d.auth}
                onChange={(e) =>
                  onChange({
                    ...state,
                    draft: { ...d, auth: e.target.value as SshAuthMethod },
                    // A different method needs a different secret.
                    secret: '',
                    secretAction: 'set',
                  })
                }
              >
                {AUTH_METHODS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}
          </Field>

          {d.auth === 'key' && (
            <PathField
              label="Private key"
              purpose="sshKey"
              value={d.keyFile}
              error={errors.keyFile}
              placeholder="e.g. ~/.ssh/id_ed25519 (absolute path)"
              onChange={(keyFile) => patch({ keyFile })}
              onError={onError}
            />
          )}
          {d.auth === 'agent' && (
            <>
              <span />
              <p className="text-[12px] text-muted">
                Uses the keys loaded in your SSH agent (ssh-add -l lists them).
              </p>
            </>
          )}

          {needsSecret && (
            <>
              <Field label={`Save ${secretLabel.toLowerCase()}`}>
                {(id) => (
                  <select
                    id={id}
                    className={input}
                    value={d.saveMode}
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
              <Field label={secretLabel}>
                {(id) =>
                  state.secretAction === 'keep' && saved?.secretSaved ? (
                    <div id={id} className="flex items-center gap-3 py-1">
                      <span className="text-muted">Saved</span>
                      <button
                        type="button"
                        className="text-accent underline"
                        onClick={() => onChange({ ...state, secretAction: 'set' })}
                      >
                        Change…
                      </button>
                      <button
                        type="button"
                        className="text-danger underline"
                        onClick={() => onChange({ ...state, secretAction: 'clear' })}
                      >
                        Clear
                      </button>
                    </div>
                  ) : state.secretAction === 'clear' ? (
                    <div id={id} className="flex items-center gap-3 py-1">
                      <span className="text-danger">Will be removed on save</span>
                      <button
                        type="button"
                        className="text-accent underline"
                        onClick={() => onChange({ ...state, secretAction: 'keep' })}
                      >
                        Undo
                      </button>
                    </div>
                  ) : (
                    <div>
                      <input
                        id={id}
                        type="password"
                        className={input}
                        value={state.secret}
                        autoComplete="off"
                        placeholder={
                          d.saveMode === 'never'
                            ? 'For Test Connection only'
                            : d.auth === 'key'
                              ? 'Leave empty if the key has none'
                              : 'Optional'
                        }
                        onChange={(e) =>
                          onChange({ ...state, secret: e.target.value, secretAction: 'set' })
                        }
                      />
                      {d.saveMode === 'never' && (
                        <p className="mt-0.5 text-[12px] text-muted">
                          Not stored. You will be asked for it when connecting.
                        </p>
                      )}
                    </div>
                  )
                }
              </Field>
            </>
          )}

          <span />
          <p className="text-[12px] text-muted">
            The database host and port on the General tab are resolved by the SSH server. The
            server&apos;s host key is checked on first connect and must be trusted once.
          </p>
        </>
      )}
    </div>
  );
}
