import clsx from 'clsx';
import { useRef, useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import type {
  ConnectionDraft,
  ConnectionProfile,
  Isolation,
  PasswordChange,
  SaveMode,
  SshTest,
  SslMode,
  TxMode,
} from '../../ipc/types';
import { backend } from '../../ipc/client';
import type { AppError, ServerInfo } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { resetCatalog } from '../editor/catalog';
import { useMetadata } from '../explorer/metadataStore';
import { ConnectionResult } from './ConnectionResult';
import { useConnections } from './connectionsStore';
import { Field, field, input, NumberInput, PathField } from './fields';
import {
  ENVIRONMENTS,
  NEW_DRAFT,
  draftOf,
  effectiveColor,
  tabOfError,
  validateDraft,
  type DraftErrors,
} from './model';
import { SchemasTab } from './SchemasTab';
import {
  SshTab,
  sshDraftToSave,
  sshSecretChange,
  sshStateFor,
  validateSsh,
  type SshState,
} from './SshTab';
import { formatUrl, parseUrl, stripPassword } from './url';

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

type Tab = 'general' | 'ssh' | 'tls' | 'options' | 'schemas';

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'ssh', label: 'SSH' },
  { id: 'tls', label: 'TLS' },
  { id: 'options', label: 'Options' },
  { id: 'schemas', label: 'Schemas' },
];

/** Fields a URL resets to their defaults when it leaves them out. */
const URL_DEFAULTS: Partial<ConnectionDraft> = {
  host: 'localhost',
  port: 5432,
  database: '',
  sslMode: 'prefer',
  connectTimeoutSecs: 10,
  tlsCaFile: null,
  tlsCertFile: null,
  tlsKeyFile: null,
};

interface Props {
  /** Existing profile to edit; omit to create a new data source. */
  profile?: ConnectionProfile;
  onClose(): void;
}

export function ConnectionDialog({ profile, onClose }: Props) {
  const create = useConnections((s) => s.create);
  const update = useConnections((s) => s.update);
  const folders = useConnections((s) => s.folders);
  const sources = useConnections((s) => s.items);
  const sshProfiles = useConnections((s) => s.sshProfiles);
  const [draft, setDraft] = useState<ConnectionDraft>(profile ? draftOf(profile) : NEW_DRAFT);
  const [password, setPassword] = useState('');
  // Editing a profile with a saved password: keep it unless the user explicitly changes or clears it.
  const [passwordAction, setPasswordAction] = useState<'keep' | 'set' | 'clear'>(
    profile?.passwordSaved ? 'keep' : 'set',
  );
  const [ssh, setSsh] = useState<SshState>(() =>
    sshStateFor(sshProfiles.find((p) => p.id === profile?.sshProfileId)),
  );
  const [tab, setTab] = useState<Tab>('general');
  // The URL as typed while it is being edited; otherwise it is built from the fields.
  const [urlText, setUrlText] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlNote, setUrlNote] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: ServerInfo } | { error: AppError } | null>(
    null,
  );
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const errors: DraftErrors = submitted ? validateDraft(draft) : {};
  const sshErrors = submitted ? validateSsh(ssh) : {};
  const patch = (p: Partial<ConnectionDraft>) => setDraft((d) => ({ ...d, ...p }));
  const marker = effectiveColor(draft, folders);
  const tabHasError = (t: Tab) =>
    t === 'ssh'
      ? Object.keys(sshErrors).length > 0
      : Object.keys(errors).some((k) => tabOfError(k as keyof ConnectionDraft) === t);

  /** Validates everything; on failure shows the first tab with an error. */
  function valid(): boolean {
    setSubmitted(true);
    const draftErrors = Object.keys(validateDraft(draft)) as (keyof ConnectionDraft)[];
    const first: Tab | undefined = draftErrors.length
      ? tabOfError(draftErrors[0] as keyof ConnectionDraft)
      : Object.keys(validateSsh(ssh)).length
        ? 'ssh'
        : undefined;
    if (urlError) {
      setTab('general');
      return false;
    }
    if (first) {
      setTab(first);
      return false;
    }
    return true;
  }

  /** The SSH tab as the backend needs it for a test (the profile may not be saved yet). */
  function sshTest(): SshTest | null {
    if (!ssh.enabled) {
      return null;
    }
    const secret = ssh.secretAction === 'set' && ssh.secret !== '' ? ssh.secret : undefined;
    return { profile: sshDraftToSave(ssh), secret };
  }

  function testDraft(): ConnectionDraft {
    return { ...draft, sshProfileId: ssh.enabled ? ssh.profileId : null };
  }

  function typedPassword(): string | null {
    return passwordAction === 'set' && password !== '' ? password : null;
  }

  function storedPasswordOf(): string | null {
    return profile && passwordAction === 'keep' && draft.saveMode !== 'never' ? profile.id : null;
  }

  /** Tests the form as it is now (saved or not). A typed password wins over the stored one. */
  async function test() {
    if (!valid()) {
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult({
        ok: await backend.connectionTest(
          testDraft(),
          storedPasswordOf(),
          typedPassword(),
          sshTest(),
        ),
      });
    } catch (e) {
      setTestResult({ error: toAppError(e) });
    } finally {
      setTesting(false);
    }
  }

  function loadSchemas(): Promise<string[]> {
    return backend.connectionSchemas(testDraft(), profile?.id ?? null, typedPassword(), sshTest());
  }

  /** Creates or updates the SSH profile; resolves to its id (`null` without a tunnel). */
  async function saveSsh(): Promise<string | null> {
    if (!ssh.enabled) {
      return null;
    }
    const state = useConnections.getState();
    const next = sshDraftToSave(ssh);
    if (ssh.profileId) {
      const saved = state.sshProfiles.find((p) => p.id === ssh.profileId);
      const change = sshSecretChange(ssh);
      const same =
        saved &&
        change.action === 'keep' &&
        JSON.stringify(sshDraftToSave(sshStateFor(saved))) === JSON.stringify(next);
      if (!same) {
        await state.updateSshProfile(ssh.profileId, next, change);
      }
      return ssh.profileId;
    }
    const change = sshSecretChange(ssh);
    const created = await state.createSshProfile(
      next,
      change.action === 'set' ? change.value : null,
    );
    // A failure saving the data source below must not create the profile twice on retry.
    setSsh((s) => ({ ...s, profileId: created.id, secretAction: 'keep', secret: '' }));
    return created.id;
  }

  async function save() {
    if (!valid()) {
      return;
    }
    setBusy(true);
    setServerError(null);
    try {
      const next = { ...draft, sshProfileId: await saveSsh() };
      const storesPassword = next.saveMode !== 'never';
      if (profile) {
        let change: PasswordChange = { action: 'keep' };
        if (storesPassword && passwordAction === 'clear') {
          change = { action: 'clear' };
        }
        if (storesPassword && passwordAction === 'set' && password !== '') {
          change = { action: 'set', value: password };
        }
        await update(profile.id, next, change);
        const scopeChanged =
          JSON.stringify([profile.schemaNames, profile.schemaPattern]) !==
          JSON.stringify([next.schemaNames, next.schemaPattern]);
        if (scopeChanged) {
          // The live session already uses the new scope: reload what was read with the old one.
          useMetadata.getState().refresh(profile.id);
          resetCatalog(profile.id);
        }
      } else {
        await create(next, storesPassword && password !== '' ? password : null);
      }
      setPassword('');
      onClose();
    } catch (e) {
      setServerError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function editUrl(text: string) {
    setUrlText(text);
    setUrlNote(null);
    try {
      const parsed = parseUrl(text);
      setUrlError(null);
      patch({ ...URL_DEFAULTS, ...parsed.fields });
      const notes: string[] = [];
      if (parsed.password !== null) {
        setPassword(parsed.password);
        setPasswordAction('set');
        setUrlText(stripPassword(text));
        notes.push('The password was moved to the Password field; the URL never keeps it.');
      }
      if (parsed.ignored.length) {
        notes.push(`Ignored: ${parsed.ignored.join(', ')}.`);
      }
      setUrlNote(notes.join(' ') || null);
    } catch (e) {
      setUrlError(e instanceof Error ? e.message : String(e));
    }
  }

  function onTabKey(e: React.KeyboardEvent, current: Tab) {
    const i = TABS.findIndex((t) => t.id === current);
    let next: Tab | undefined;
    if (e.key === 'ArrowRight') {
      next = TABS[(i + 1) % TABS.length]?.id;
    } else if (e.key === 'ArrowLeft') {
      next = TABS[(i - 1 + TABS.length) % TABS.length]?.id;
    } else if (e.key === 'Home') {
      next = TABS[0]?.id;
    } else if (e.key === 'End') {
      next = TABS[TABS.length - 1]?.id;
    }
    if (next) {
      e.preventDefault();
      setTab(next);
      tabRefs.current[next]?.focus();
    }
  }

  const grid = 'grid grid-cols-[130px_1fr] items-start gap-x-3 gap-y-2.5';
  const showError = (message: string) => setServerError(message);

  return (
    <Modal
      title={profile ? `Data Source: ${profile.name}` : 'New PostgreSQL Data Source'}
      onClose={onClose}
      width={620}
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
      <div
        role="tablist"
        aria-label="Data source settings"
        className="mb-3 flex border-b border-border"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`ds-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`ds-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onTabKey(e, t.id)}
            className={clsx(
              '-mb-px border-b-2 px-3 py-1',
              tab === t.id
                ? 'border-accent text-fg'
                : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {t.label}
            {t.id === 'ssh' && ssh.enabled && <span className="sr-only"> (on)</span>}
            {tabHasError(t.id) && (
              <span className="ml-1 text-danger" aria-label="has errors">
                •
              </span>
            )}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div
          role="tabpanel"
          id="ds-panel-general"
          aria-labelledby="ds-tab-general"
          hidden={tab !== 'general'}
          className={grid}
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

          {folders.length > 0 && (
            <Field label="Folder">
              {(id) => (
                <select
                  id={id}
                  className={input}
                  value={draft.folderId ?? ''}
                  onChange={(e) => patch({ folderId: e.target.value || null })}
                >
                  <option value="">(top level)</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}

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

          <Field label="Connection type">
            {(id) => (
              <select
                id={id}
                className={input}
                value={draft.urlOnly ? 'url' : 'fields'}
                onChange={(e) => patch({ urlOnly: e.target.value === 'url' })}
              >
                <option value="fields">Host, port and database</option>
                <option value="url">URL only</option>
              </select>
            )}
          </Field>

          <Field label="URL" error={urlError ?? undefined}>
            {(id, describedBy) => (
              <div>
                <input
                  id={id}
                  className={`${input} font-mono text-[12px]`}
                  value={urlText ?? formatUrl(draft)}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!!urlError}
                  aria-describedby={describedBy ?? (urlNote ? `${id}-note` : undefined)}
                  onChange={(e) => editUrl(e.target.value)}
                  onBlur={() => {
                    if (!urlError) {
                      setUrlText(null);
                    }
                  }}
                />
                {urlNote && (
                  <p id={`${id}-note`} className="mt-0.5 text-[12px] text-muted">
                    {urlNote}
                  </p>
                )}
              </div>
            )}
          </Field>

          {!draft.urlOnly && (
            <>
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
            </>
          )}
          {draft.urlOnly && (errors.host || errors.port || errors.username) && (
            <>
              <span />
              <p className="text-[12px] text-danger">
                {errors.host ?? errors.port ?? errors.username}
              </p>
            </>
          )}

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
        </div>

        <div role="tabpanel" id="ds-panel-ssh" aria-labelledby="ds-tab-ssh" hidden={tab !== 'ssh'}>
          <SshTab
            state={ssh}
            profiles={sshProfiles}
            sources={sources}
            editingId={profile?.id ?? null}
            errors={sshErrors}
            onChange={setSsh}
            onError={showError}
          />
        </div>

        <div
          role="tabpanel"
          id="ds-panel-tls"
          aria-labelledby="ds-tab-tls"
          hidden={tab !== 'tls'}
          className={grid}
        >
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
          <PathField
            label="CA file"
            purpose="tlsCa"
            value={draft.tlsCaFile}
            error={errors.tlsCaFile}
            placeholder="System trust store"
            onChange={(tlsCaFile) => patch({ tlsCaFile })}
            onError={showError}
          />
          <PathField
            label="Client certificate"
            purpose="tlsCert"
            value={draft.tlsCertFile}
            error={errors.tlsCertFile}
            onChange={(tlsCertFile) => patch({ tlsCertFile })}
            onError={showError}
          />
          <PathField
            label="Client key"
            purpose="tlsKey"
            value={draft.tlsKeyFile}
            error={errors.tlsKeyFile}
            onChange={(tlsKeyFile) => patch({ tlsKeyFile })}
            onError={showError}
          />
          <span />
          <div className="space-y-1 text-[12px] text-muted">
            <p>
              PEM files, read when connecting; only their paths are saved. The client key must not
              be encrypted.
            </p>
            <p>
              Verify CA checks the server certificate against the CA file (or the system store);
              Verify full also checks the host name. With a CA file, Require verifies the chain too,
              as libpq does.
            </p>
          </div>
        </div>

        <div
          role="tabpanel"
          id="ds-panel-options"
          aria-labelledby="ds-tab-options"
          hidden={tab !== 'options'}
          className={grid}
        >
          <Field label="Connect timeout" error={errors.connectTimeoutSecs}>
            {(id, describedBy) => (
              <div className="flex items-center gap-2">
                <NumberInput
                  id={id}
                  value={draft.connectTimeoutSecs}
                  min={1}
                  max={300}
                  invalid={!!errors.connectTimeoutSecs}
                  describedBy={describedBy}
                  onChange={(connectTimeoutSecs) => patch({ connectTimeoutSecs })}
                />
                <span className="text-muted">seconds</span>
              </div>
            )}
          </Field>

          <Field label="Keep-alive" error={errors.keepaliveSecs}>
            {(id, describedBy) => (
              <div className="flex items-center gap-2">
                <NumberInput
                  id={id}
                  value={draft.keepaliveSecs}
                  min={0}
                  max={3600}
                  invalid={!!errors.keepaliveSecs}
                  describedBy={describedBy}
                  onChange={(keepaliveSecs) => patch({ keepaliveSecs })}
                />
                <span className="text-muted">seconds idle before TCP keep-alive (0: system)</span>
              </div>
            )}
          </Field>

          <Field label="Auto-disconnect" error={errors.autoDisconnectMins}>
            {(id, describedBy) => (
              <div className="flex items-center gap-2">
                <NumberInput
                  id={id}
                  value={draft.autoDisconnectMins}
                  min={0}
                  max={1440}
                  invalid={!!errors.autoDisconnectMins}
                  describedBy={describedBy}
                  onChange={(autoDisconnectMins) => patch({ autoDisconnectMins })}
                />
                <span className="text-muted">idle minutes (0: never)</span>
              </div>
            )}
          </Field>
          <span />
          <p className="-mt-1.5 text-[12px] text-muted">
            Never while a statement runs or a transaction is open.
          </p>

          <Field label="Startup SQL">
            {(id) => (
              <div>
                <textarea
                  id={id}
                  rows={3}
                  spellCheck={false}
                  className={`${input} font-mono text-[12px]`}
                  value={draft.startupSql}
                  placeholder="e.g. SET search_path = app, public;"
                  aria-describedby={`${id}-help`}
                  onChange={(e) => patch({ startupSql: e.target.value })}
                />
                <p id={`${id}-help`} className="mt-0.5 text-[12px] text-muted">
                  Runs after every connect, also for consoles with their own session.
                </p>
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

          <span />
          <div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={draft.historyEnabled}
                aria-describedby="connection-history-help"
                onChange={(e) => patch({ historyEnabled: e.target.checked })}
              />
              Record query history
            </label>
            <p id="connection-history-help" className="mt-0.5 text-muted">
              Statements are kept on this computer as typed, including any values written in them.
              Turn this off for data sources whose queries hold sensitive values.
            </p>
          </div>
        </div>

        <div
          role="tabpanel"
          id="ds-panel-schemas"
          aria-labelledby="ds-tab-schemas"
          hidden={tab !== 'schemas'}
        >
          <SchemasTab draft={draft} patch={patch} load={loadSchemas} />
        </div>

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
