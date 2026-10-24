import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from '../../app/settingsStore';
import { Modal } from '../../components/ui/Modal';
import { backend } from '../../ipc/client';
import type { AiPreview, AiStreamEvent } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { LEVEL_LABELS } from './ConsentDialog';
import { PayloadPreview } from './PayloadPreview';
import { chooseConsent, prepareAiRequest } from './requestFlow';

type Phase =
  | { step: 'compose' }
  | { step: 'preview'; preview: AiPreview }
  | { step: 'answer'; text: string; running: boolean; note: string | null };

const button = 'rounded border border-border px-3 py-1 hover:bg-hover disabled:opacity-50';
const primary = 'rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50';

/**
 * Ask the AI about the SQL in the active console. Nothing is sent until the user has seen the
 * exact request and pressed Send; nothing the AI writes is run.
 */
export function AskAiDialog({
  sourceId,
  sql,
  schema,
  onClose,
}: {
  sourceId: string;
  sql: string;
  schema: string | null;
  onClose(): void;
}) {
  const ids = useId();
  const source = useConnections((s) => s.items.find((c) => c.id === sourceId));
  const [question, setQuestion] = useState('');
  const [phase, setPhase] = useState<Phase>({ step: 'compose' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [levelLabel, setLevelLabel] = useState<string | null>(null);
  const running = useRef<string | null>(null);

  useEffect(() => {
    let current = true;
    backend
      .aiConsentGet(sourceId)
      .then((c) => {
        if (current) {
          setLevelLabel(c.decided ? LEVEL_LABELS[c.level] : 'not chosen yet');
        }
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [sourceId, phase.step]);

  // Closing stops a running answer.
  useEffect(
    () => () => {
      if (running.current) {
        void backend.aiCancel(running.current);
      }
    },
    [],
  );

  async function previewRequest() {
    setError(null);
    setBusy(true);
    try {
      const preview = await prepareAiRequest({
        sourceId,
        task: { kind: 'ask', question: question.trim() },
        sql,
        schema,
      });
      if (preview) {
        setPhase({ step: 'preview', preview });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeContext() {
    setError(null);
    try {
      const consent = await backend.aiConsentGet(sourceId);
      await chooseConsent(sourceId, { ...consent, decided: true });
      setPhase({ step: 'compose' });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function onEvent(e: AiStreamEvent) {
    if (e.type === 'done' || e.type === 'failed') {
      running.current = null;
    }
    setPhase((p) => {
      const text = p.step === 'answer' ? p.text : '';
      switch (e.type) {
        case 'started':
          return { step: 'answer', text, running: true, note: null };
        case 'text':
          return { step: 'answer', text: text + e.text, running: true, note: null };
        case 'done':
          return {
            step: 'answer',
            text,
            running: false,
            note: e.stopReason === 'refusal' ? 'The model declined to answer.' : null,
          };
        case 'failed':
          return { step: 'answer', text, running: false, note: e.error.message };
      }
    });
  }

  async function send(preview: AiPreview) {
    setError(null);
    setPhase({ step: 'answer', text: '', running: true, note: null });
    try {
      running.current = await backend.aiSend(preview.payloadId, onEvent);
    } catch (e) {
      setPhase({ step: 'compose' });
      setError(errorMessage(e));
    }
  }

  function stop() {
    const requestId = running.current;
    running.current = null;
    if (requestId) {
      void backend.aiCancel(requestId);
    }
    setPhase((p) => (p.step === 'answer' ? { ...p, running: false, note: 'Stopped.' } : p));
  }

  const footer =
    phase.step === 'compose' ? (
      <>
        <button type="button" className={button} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={primary}
          disabled={busy || !question.trim()}
          onClick={() => void previewRequest()}
        >
          Preview Request
        </button>
      </>
    ) : phase.step === 'preview' ? (
      <>
        <button type="button" className={button} onClick={() => setPhase({ step: 'compose' })}>
          Back
        </button>
        <button type="button" className={primary} onClick={() => void send(phase.preview)}>
          Send
        </button>
      </>
    ) : phase.running ? (
      <button type="button" className={button} onClick={stop}>
        Stop
      </button>
    ) : (
      <button type="button" className={button} onClick={onClose}>
        Close
      </button>
    );

  return (
    <Modal title="Ask AI" onClose={onClose} width={640} footer={footer}>
      <div className="space-y-3">
        <p className="text-[12px] text-muted">
          Data source: <span className="text-fg">{source?.name ?? sourceId}</span> · Context:{' '}
          <span className="text-fg">{levelLabel ?? '…'}</span>{' '}
          {phase.step === 'compose' && (
            <button
              type="button"
              className="underline hover:no-underline"
              onClick={() => void changeContext()}
            >
              Change
            </button>
          )}
        </p>
        {phase.step === 'compose' && (
          <>
            <div>
              <label htmlFor={`${ids}-question`} className="mb-1 block">
                Question or request
              </label>
              <textarea
                id={`${ids}-question`}
                rows={3}
                className="w-full rounded border border-border bg-bg px-2 py-1"
                placeholder="Explain this query, or: orders per customer last month"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </div>
            {sql.trim() && (
              <details>
                <summary className="cursor-pointer">SQL from the editor</summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[12px] whitespace-pre-wrap">
                  {sql}
                </pre>
              </details>
            )}
          </>
        )}
        {phase.step === 'preview' && <PayloadPreview preview={phase.preview} />}
        {phase.step === 'answer' && (
          <div className="space-y-1">
            <pre
              role="log"
              aria-label="Answer"
              tabIndex={0}
              className="max-h-80 min-h-[3em] overflow-auto rounded border border-border bg-bg p-2 font-mono text-[12px] whitespace-pre-wrap"
            >
              {phase.text || (phase.running ? 'Waiting for the answer…' : '')}
            </pre>
            {phase.note && <p className="text-[12px] text-muted">{phase.note}</p>}
            <p className="text-[12px] text-muted">
              Nothing here runs by itself. Copy what you need into the editor and run it there.
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
