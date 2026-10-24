import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { LineDiff } from '../../components/ui/LineDiff';
import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { AiConsent } from '../../ipc/types';
import { diffLines } from '../../lib/diff';
import { useConnections } from '../connections/connectionsStore';
import { useNotifications } from '../notifications/notifications';
import { aiAvailable, useAi } from './aiStore';
import { consoleContext, proposedSql, useAssistant } from './assistantStore';
import { LEVEL_LABELS } from './ConsentDialog';
import { PayloadPreview } from './PayloadPreview';
import { chooseConsent } from './requestFlow';

const button = 'rounded border border-border px-2 py-0.5 hover:bg-hover disabled:opacity-50';
const primary = 'rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50';

const TASK_TITLES = {
  ask: 'Answer',
  generate: 'Generated SQL',
  explainQuery: 'Explanation of the query',
  explainError: 'Explanation of the error',
  fix: 'Proposed fix',
} as const;

/**
 * The AI side panel: prompt, consent, the exact request before Send, the streamed answer, and
 * proposed SQL as a diff with Insert and Discard. It never runs anything: inserted SQL is
 * ordinary editor text that runs only through Run, with every guard.
 */
export function AssistantPanel() {
  const ids = useId();
  const available = useAi((s) => aiAvailable(s.status));
  const { open, context, phase, error } = useAssistant();
  const { setOpen, start, send, stop, reset, insert } = useAssistant.getState();
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const activeTab = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const sourceId = context?.sourceId ?? (isConsole(activeTab) ? activeTab.sourceId : null);
  const source = useConnections((s) => s.items.find((c) => c.id === sourceId));
  const [prompt, setPrompt] = useState('');
  const [consent, setConsent] = useState<AiConsent | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    if (open && available && sourceId) {
      backend
        .aiConsentGet(sourceId)
        .then((c) => {
          if (current) {
            setConsent(c);
          }
        })
        .catch(() => {});
    }
    return () => {
      current = false;
    };
  }, [open, available, sourceId, phase.step]);

  const proposal =
    phase.step === 'answer' && !phase.running && !phase.failed
      ? proposedSql(context, phase.text)
      : null;
  const diff = useMemo(
    () =>
      proposal !== null && context?.target ? diffLines(context.target.original, proposal) : null,
    [proposal, context],
  );
  const insertHere = context?.target?.tabId === activeTabId;

  function ask(kind: 'generate' | 'ask' | 'explainQuery') {
    setProblem(null);
    const c = consoleContext();
    if (typeof c === 'string') {
      setProblem(c);
      return;
    }
    if (kind === 'explainQuery' && !c.sql.trim()) {
      setProblem('Put the caret in a statement or select some SQL to explain.');
      return;
    }
    const task =
      kind === 'generate'
        ? { kind, request: prompt.trim() }
        : kind === 'ask'
          ? { kind, question: prompt.trim() }
          : { kind };
    void start({
      sourceId: c.sourceId,
      schema: c.schema,
      task,
      sql: c.sql,
      target: kind === 'explainQuery' ? null : c.target,
    });
  }

  async function changeContext() {
    if (!sourceId) {
      return;
    }
    const current = consent ?? (await backend.aiConsentGet(sourceId));
    const chosen = await chooseConsent(sourceId, { ...current, decided: true });
    if (chosen) {
      setConsent(chosen);
    }
  }

  function doInsert() {
    insert();
    useNotifications
      .getState()
      .notify('Inserted into the console. It runs only when you press Run.');
  }

  return (
    <aside aria-label="AI assistant" className="flex h-full min-w-0 flex-col bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <h2 className="flex-1 text-[13px] font-semibold">AI Assistant</h2>
        <button
          type="button"
          aria-label="Close the AI panel"
          className="rounded p-0.5 hover:bg-hover"
          onClick={() => setOpen(false)}
        >
          <X size={14} />
        </button>
      </div>
      {!available ? (
        <p className="p-3 text-muted">
          AI is off. Turn it on and add an API key in Settings &gt; AI.
        </p>
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
          <p className="text-[12px] text-muted">
            {source ? (
              <>
                Data source: <span className="text-fg">{source.name}</span> · Context:{' '}
                <span className="text-fg">
                  {consent
                    ? consent.decided
                      ? LEVEL_LABELS[consent.level]
                      : 'not chosen yet'
                    : '…'}
                </span>{' '}
                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={() => void changeContext()}
                >
                  Change
                </button>
              </>
            ) : (
              'Open a console with a data source to use the assistant.'
            )}
          </p>

          {(phase.step === 'compose' || phase.step === 'preparing') && (
            <div className="space-y-2">
              <label htmlFor={`${ids}-prompt`} className="block">
                Ask, or describe the SQL you need
              </label>
              <textarea
                id={`${ids}-prompt`}
                rows={4}
                className="w-full rounded border border-border bg-bg px-2 py-1"
                placeholder="orders per customer in the last 30 days"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={primary}
                  disabled={!prompt.trim() || phase.step === 'preparing'}
                  onClick={() => ask('generate')}
                >
                  Generate SQL
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={!prompt.trim() || phase.step === 'preparing'}
                  onClick={() => ask('ask')}
                >
                  Ask
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={phase.step === 'preparing'}
                  onClick={() => ask('explainQuery')}
                >
                  Explain Query
                </button>
              </div>
              <p className="text-[12px] text-muted">
                The selection, or the statement at the caret, goes with the request. You see the
                exact request before anything is sent.
              </p>
            </div>
          )}

          {phase.step === 'preparing' && <p className="text-muted">Preparing the request…</p>}

          {phase.step === 'preview' && (
            <div className="space-y-2">
              <PayloadPreview preview={phase.preview} />
              <div className="flex gap-2">
                <button type="button" className={button} onClick={reset}>
                  Back
                </button>
                <button type="button" className={primary} onClick={() => void send()}>
                  Send
                </button>
              </div>
            </div>
          )}

          {phase.step === 'answer' && context && (
            <div className="space-y-2">
              <h3 className="font-semibold">{TASK_TITLES[context.task.kind]}</h3>
              <pre
                role="log"
                aria-label="Answer"
                tabIndex={0}
                className="max-h-72 min-h-[3em] overflow-auto rounded border border-border bg-bg p-2 font-mono text-[12px] whitespace-pre-wrap"
              >
                {phase.text || (phase.running ? 'Waiting for the answer…' : '')}
              </pre>
              {phase.note && (
                <p className={phase.failed ? 'text-[12px] text-danger' : 'text-[12px] text-muted'}>
                  {phase.note}
                </p>
              )}
              {phase.running ? (
                <button type="button" className={button} onClick={stop}>
                  Stop
                </button>
              ) : (
                <>
                  {proposal !== null && (
                    <section aria-label="Proposed SQL" className="space-y-2">
                      <p className="text-[12px] text-muted">
                        {context.target?.original
                          ? 'Changes to your SQL:'
                          : 'SQL to insert at the caret:'}
                      </p>
                      <div className="overflow-auto rounded border border-border bg-bg font-mono text-[12px]">
                        {diff ? (
                          <LineDiff lines={diff} />
                        ) : (
                          <pre className="p-2 whitespace-pre-wrap">{proposal}</pre>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className={primary}
                          disabled={!insertHere}
                          onClick={doInsert}
                        >
                          Insert
                        </button>
                        <button type="button" className={button} onClick={reset}>
                          Discard
                        </button>
                        {!insertHere && (
                          <span className="text-[12px] text-muted">
                            Switch to the console it belongs to, to insert it.
                          </span>
                        )}
                      </div>
                    </section>
                  )}
                  {proposal === null && (
                    <button type="button" className={button} onClick={reset}>
                      New Request
                    </button>
                  )}
                </>
              )}
            </div>
          )}

          <p className="text-[12px] text-muted">
            The assistant never runs SQL. Inserted SQL runs only when you press Run, with the usual
            checks for read-only, destructive and production statements.
          </p>
          {(error ?? problem) && (
            <p role="alert" className="text-danger">
              {error ?? problem}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
