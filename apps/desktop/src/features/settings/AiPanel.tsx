import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from '../../app/settingsStore';
import { backend } from '../../ipc/client';
import type { AiIgnoreKind, AiModels, AiSettings, AiStreamEvent } from '../../ipc/types';
import { AI_FALLBACK_MODELS } from '../../ipc/types';
import { AiActivity } from '../ai/AiActivity';
import { useAi } from '../ai/aiStore';

const input = 'rounded border border-border bg-bg px-2 py-1';
const button = 'rounded border border-border px-2 py-0.5 hover:bg-hover disabled:opacity-50';

type TestState =
  | { phase: 'idle' }
  | { phase: 'running'; text: string }
  | { phase: 'done'; text: string; detail: string }
  | { phase: 'failed'; text: string; detail: string }
  | { phase: 'cancelled'; text: string };

/**
 * Settings > AI: the switch, the API key (write-only), the model, a streamed test, and the ignore
 * list. Changes are saved as they are made, separately from the other settings.
 */
export function AiPanel() {
  const status = useAi((s) => s.status);
  const { saveSettings, setKey, clearKey } = useAi.getState();
  const settings = status.settings;
  const ids = useId();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [models, setModels] = useState<AiModels>({ models: AI_FALLBACK_MODELS, live: false });
  const [refreshes, setRefreshes] = useState(0);
  const [test, setTest] = useState<TestState>({ phase: 'idle' });
  const running = useRef<string | null>(null);
  const [ruleKind, setRuleKind] = useState<AiIgnoreKind>('table');
  const [rulePattern, setRulePattern] = useState('');

  const workspaceOff = settings.disabledWorkspaces.includes(status.workspaceId);

  useEffect(() => {
    let current = true;
    backend
      .aiModels()
      .then((m) => {
        if (current) {
          setModels(m);
        }
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [status.active, status.keyStored, refreshes]);

  // Leaving the page stops a running test.
  useEffect(
    () => () => {
      if (running.current) {
        void backend.aiCancel(running.current);
      }
    },
    [],
  );

  async function run(action: () => Promise<void>, done?: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) {
        setNotice(done);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const save = (patch: Partial<AiSettings>, done?: string) =>
    run(() => saveSettings({ ...settings, ...patch }), done);

  function onTestEvent(e: AiStreamEvent) {
    if (e.type === 'done' || e.type === 'failed') {
      running.current = null;
    }
    setTest((t) => {
      const text = t.phase === 'idle' ? '' : t.text;
      switch (e.type) {
        case 'started':
          return { phase: 'running', text };
        case 'text':
          return { phase: 'running', text: text + e.text };
        case 'done':
          return {
            phase: 'done',
            text,
            detail:
              e.stopReason === 'refusal'
                ? 'The model declined to answer.'
                : `Connected. ${e.usage.inputTokens} input and ${e.usage.outputTokens} output tokens.`,
          };
        case 'failed':
          return { phase: 'failed', text, detail: e.error.message };
      }
    });
  }

  async function startTest() {
    setError(null);
    setTest({ phase: 'running', text: '' });
    try {
      running.current = await backend.aiTest(onTestEvent);
    } catch (e) {
      setTest({ phase: 'failed', text: '', detail: errorMessage(e) });
    }
  }

  function cancelTest() {
    const requestId = running.current;
    running.current = null;
    if (requestId) {
      void backend.aiCancel(requestId);
    }
    setTest((t) => ({ phase: 'cancelled', text: t.phase === 'idle' ? '' : t.text }));
  }

  const modelOptions = models.models.some((m) => m.id === settings.model)
    ? models.models
    : [{ id: settings.model, displayName: settings.model }, ...models.models];

  return (
    <div className="max-h-[480px] space-y-4 overflow-auto pr-1">
      <section aria-labelledby={`${ids}-where`} className="rounded border border-border p-2">
        <h3 id={`${ids}-where`} className="font-semibold">
          Where your data goes
        </h3>
        <p className="mt-1 text-muted">
          Quarry sends AI requests directly from this computer to Anthropic&apos;s API, using your
          own API key. Prompts are not sent anywhere else, and nothing is sent while AI is off.
          Before any request, you will see exactly what it contains.
        </p>
      </section>

      <div className="space-y-1">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) =>
              void save(
                { enabled: e.target.checked },
                e.target.checked ? 'AI is on.' : 'AI is off. No requests will be sent.',
              )
            }
          />
          Enable AI features
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={workspaceOff}
            onChange={(e) =>
              void save({
                disabledWorkspaces: e.target.checked
                  ? [...settings.disabledWorkspaces, status.workspaceId]
                  : settings.disabledWorkspaces.filter((w) => w !== status.workspaceId),
              })
            }
          />
          Turn AI off in this workspace
        </label>
        <p className="text-[12px] text-muted">
          {status.active
            ? 'AI is on for this workspace.'
            : 'AI is off: AI actions are hidden and no request leaves this computer.'}
        </p>
      </div>

      <div className="grid grid-cols-[110px_1fr] items-start gap-x-3 gap-y-3">
        <span className="pt-1">API key</span>
        <div className="space-y-1">
          {!editingKey && (
            <div className="flex flex-wrap items-center gap-2">
              <span>
                {status.keyStored ? 'Stored in the system credential store.' : 'No key stored.'}
              </span>
              <button type="button" className={button} onClick={() => setEditingKey(true)}>
                {status.keyStored ? 'Change' : 'Add Key'}
              </button>
              {status.keyStored && (
                <button
                  type="button"
                  className={`${button} text-danger`}
                  onClick={() => void run(() => clearKey(), 'The key was removed.')}
                >
                  Remove
                </button>
              )}
            </div>
          )}
          {editingKey && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await setKey(keyDraft.trim());
                  setKeyDraft('');
                  setEditingKey(false);
                }, 'The key was saved in the system credential store.');
              }}
            >
              <label htmlFor={`${ids}-key`} className="sr-only">
                Anthropic API key
              </label>
              <input
                id={`${ids}-key`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-..."
                className={`${input} w-72 font-mono`}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
              <button
                type="submit"
                className="rounded bg-accent px-3 py-1 text-accent-fg"
                disabled={!keyDraft.trim()}
              >
                Save Key
              </button>
              <button
                type="button"
                className={button}
                onClick={() => {
                  setKeyDraft('');
                  setEditingKey(false);
                }}
              >
                Cancel
              </button>
            </form>
          )}
          <p className="text-[12px] text-muted">
            The key is kept only in the system credential store and is never shown again.
          </p>
        </div>

        <label htmlFor={`${ids}-model`} className="pt-1">
          Model
        </label>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <select
              id={`${ids}-model`}
              className={input}
              value={settings.model}
              onChange={(e) => void save({ model: e.target.value })}
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={button}
              disabled={!status.active || !status.keyStored}
              onClick={() => setRefreshes((n) => n + 1)}
            >
              Refresh List
            </button>
          </div>
          <p className="text-[12px] text-muted">
            {models.live
              ? 'Models available to your key.'
              : models.error
                ? `Built-in list (could not load the live list: ${models.error}).`
                : 'Built-in list; the live list loads when AI is on and a key is stored.'}
          </p>
        </div>

        <span className="pt-1">Connection</span>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {test.phase === 'running' ? (
              <button type="button" className={button} onClick={cancelTest}>
                Cancel Test
              </button>
            ) : (
              <button
                type="button"
                className={button}
                disabled={!status.active || !status.keyStored}
                onClick={() => void startTest()}
              >
                Test
              </button>
            )}
            <span className="text-[12px] text-muted">
              Sends a one-line test message, no data from your databases.
            </span>
          </div>
          {test.phase !== 'idle' && (
            <div role="status" aria-label="Test result" className="space-y-1">
              <pre className="min-h-[1.5em] rounded border border-border bg-bg p-1 font-mono text-[12px] whitespace-pre-wrap">
                {test.text || (test.phase === 'running' ? 'Waiting for the answer…' : '')}
              </pre>
              {test.phase === 'done' && <p className="text-[12px]">{test.detail}</p>}
              {test.phase === 'failed' && <p className="text-[12px] text-danger">{test.detail}</p>}
              {test.phase === 'cancelled' && <p className="text-[12px] text-muted">Cancelled.</p>}
            </div>
          )}
        </div>
      </div>

      <section aria-labelledby={`${ids}-ignore`} className="space-y-2">
        <h3 id={`${ids}-ignore`} className="font-semibold">
          Never send these
        </h3>
        <p className="text-[12px] text-muted">
          Tables and columns listed here are left out of anything sent to the AI. Patterns ignore
          case; <code>*</code> matches any characters and <code>?</code> one. Tables:{' '}
          <code>table</code> or <code>schema.table</code>. Columns: <code>column</code>,{' '}
          <code>table.column</code> or <code>schema.table.column</code>.
        </p>
        {settings.ignore.length > 0 && (
          <ul aria-label="Ignore list" className="rounded border border-border bg-bg py-1">
            {settings.ignore.map((rule, index) => (
              <li
                key={`${rule.kind}:${rule.pattern}:${index}`}
                className="flex items-center gap-2 px-2 py-0.5"
              >
                <span className="w-16 text-muted">
                  {rule.kind === 'table' ? 'Table' : 'Column'}
                </span>
                <span className="flex-1 font-mono">{rule.pattern}</span>
                <button
                  type="button"
                  className={button}
                  aria-label={`Remove ${rule.kind} ${rule.pattern}`}
                  onClick={() =>
                    void save({ ignore: settings.ignore.filter((_, i) => i !== index) })
                  }
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const pattern = rulePattern.trim();
            if (!pattern) {
              return;
            }
            void run(async () => {
              await saveSettings({
                ...settings,
                ignore: [...settings.ignore, { kind: ruleKind, pattern }],
              });
              setRulePattern('');
            });
          }}
        >
          <label htmlFor={`${ids}-rule-kind`} className="sr-only">
            Kind
          </label>
          <select
            id={`${ids}-rule-kind`}
            className={input}
            value={ruleKind}
            onChange={(e) => setRuleKind(e.target.value as AiIgnoreKind)}
          >
            <option value="table">Table</option>
            <option value="column">Column</option>
          </select>
          <label htmlFor={`${ids}-rule-pattern`} className="sr-only">
            Pattern
          </label>
          <input
            id={`${ids}-rule-pattern`}
            className={`${input} w-64 font-mono`}
            placeholder={ruleKind === 'table' ? 'billing.*' : '*password*'}
            value={rulePattern}
            onChange={(e) => setRulePattern(e.target.value)}
          />
          <button type="submit" className={button} disabled={!rulePattern.trim()}>
            Add
          </button>
        </form>
      </section>

      <AiActivity />

      {notice && (
        <p role="status" className="text-muted">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
