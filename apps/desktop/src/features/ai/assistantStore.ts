import { create } from 'zustand';
import { errorMessage } from '../../app/settingsStore';
import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { AiPreview, AiStreamEvent, AiTask, StatementError } from '../../ipc/types';
import { statementAt } from '../../lib/sql/statements';
import { activeEditor } from '../editor/editorHandle';
import { useExec } from '../exec/execStore';
import { useNotifications } from '../notifications/notifications';
import { extractSql } from './extractSql';
import { prepareAiRequest } from './requestFlow';

/** Where Insert puts proposed SQL: `[start, end)` of a console's text, as it was when asked. */
export interface AiTarget {
  tabId: string;
  start: number;
  end: number;
  original: string;
}

export interface AiRequestContext {
  sourceId: string;
  schema: string | null;
  task: AiTask;
  sql: string;
  /** Where proposed SQL may be inserted; `null` for explanations. */
  target: AiTarget | null;
}

export type AssistantPhase =
  | { step: 'compose' }
  | { step: 'preparing' }
  | { step: 'preview'; preview: AiPreview }
  | {
      step: 'answer';
      text: string;
      running: boolean;
      /** Why it ended early (error, refusal, stopped). */
      note: string | null;
      failed: boolean;
    };

interface AssistantState {
  open: boolean;
  context: AiRequestContext | null;
  phase: AssistantPhase;
  error: string | null;
  setOpen(open: boolean): void;
  /** Opens the panel and prepares a request: consent, objects, preview. Nothing is sent. */
  start(context: AiRequestContext): Promise<void>;
  /** Sends the previewed request (the only way a request leaves). */
  send(): Promise<void>;
  stop(): void;
  /** Back to the prompt; a running answer is stopped. */
  reset(): void;
  /** Puts the proposed SQL into the editor. Never runs it. */
  insert(): void;
}

let requestId: string | null = null;
/** Bumped whenever the panel moves on, so late events of an earlier request are ignored. */
let generation = 0;

/** Tasks whose answer may hold SQL to insert. */
const PROPOSES_SQL = new Set<AiTask['kind']>(['ask', 'generate', 'fix']);

/** The SQL an answer proposes, when the task is one that proposes SQL. */
export function proposedSql(context: AiRequestContext | null, answer: string): string | null {
  if (!context?.target || !PROPOSES_SQL.has(context.task.kind)) {
    return null;
  }
  return extractSql(answer);
}

export const useAssistant = create<AssistantState>((set, get) => {
  function onEvent(e: AiStreamEvent) {
    if (e.type === 'done' || e.type === 'failed') {
      requestId = null;
    }
    set((s) => {
      const text = s.phase.step === 'answer' ? s.phase.text : '';
      switch (e.type) {
        case 'started':
          return { phase: { step: 'answer', text, running: true, note: null, failed: false } };
        case 'text':
          return {
            phase: {
              step: 'answer',
              text: text + e.text,
              running: true,
              note: null,
              failed: false,
            },
          };
        case 'done':
          return {
            phase: {
              step: 'answer',
              text,
              running: false,
              note: e.stopReason === 'refusal' ? 'The model declined to answer.' : null,
              failed: e.stopReason === 'refusal',
            },
          };
        case 'failed':
          return {
            phase: { step: 'answer', text, running: false, note: e.error.message, failed: true },
          };
      }
    });
  }

  function stopRunning() {
    generation += 1;
    if (requestId) {
      void backend.aiCancel(requestId);
      requestId = null;
    }
  }

  return {
    open: false,
    context: null,
    phase: { step: 'compose' },
    error: null,
    setOpen(open) {
      set({ open });
    },
    async start(context) {
      stopRunning();
      set({ open: true, context, phase: { step: 'preparing' }, error: null });
      try {
        const preview = await prepareAiRequest(context);
        set({ phase: preview ? { step: 'preview', preview } : { step: 'compose' } });
      } catch (e) {
        set({ phase: { step: 'compose' }, error: errorMessage(e) });
      }
    },
    async send() {
      const { phase } = get();
      if (phase.step !== 'preview') {
        return;
      }
      set({
        phase: { step: 'answer', text: '', running: true, note: null, failed: false },
        error: null,
      });
      const mine = ++generation;
      try {
        const id = await backend.aiSend(phase.preview.payloadId, (e) => {
          if (mine === generation) {
            onEvent(e);
          }
        });
        if (mine === generation) {
          requestId = id;
        } else {
          // Stopped or moved on while the request was being sent.
          void backend.aiCancel(id);
        }
      } catch (e) {
        set({ phase: { step: 'compose' }, error: errorMessage(e) });
      }
    },
    stop() {
      stopRunning();
      set((s) =>
        s.phase.step === 'answer'
          ? { phase: { ...s.phase, running: false, note: 'Stopped.' } }
          : {},
      );
    },
    reset() {
      stopRunning();
      set({ phase: { step: 'compose' }, error: null });
    },
    insert() {
      const { context, phase } = get();
      const sql = phase.step === 'answer' ? proposedSql(context, phase.text) : null;
      const target = context?.target;
      const editor = activeEditor();
      const ws = useWorkspace.getState();
      if (!sql || !target || !editor || ws.activeTabId !== target.tabId) {
        return;
      }
      const text = editor.getText();
      if (text.slice(target.start, target.end) === target.original) {
        editor.replaceRange(target.start, target.end, sql);
      } else {
        // The text moved on since the request; do not overwrite whatever is there now.
        editor.insertText(sql);
        useNotifications
          .getState()
          .notify('The console changed since the request, so the SQL was inserted at the caret.');
      }
      set({ phase: { step: 'compose' }, error: null });
    },
  };
});

/** The active console's data source and SQL: the selection, else the statement at the caret. */
export function consoleContext():
  | { tabId: string; sourceId: string; schema: string | null; sql: string; target: AiTarget }
  | string {
  const ws = useWorkspace.getState();
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
  const editor = activeEditor();
  if (!isConsole(tab) || !editor) {
    return 'The AI assistant works with a console.';
  }
  if (!tab.sourceId) {
    return 'Choose a data source for this console first.';
  }
  const text = editor.getText();
  const selection = editor.getSelection();
  if (selection.end > selection.start) {
    const sql = text.slice(selection.start, selection.end);
    return {
      tabId: tab.id,
      sourceId: tab.sourceId,
      schema: tab.schema ?? null,
      sql,
      target: { tabId: tab.id, start: selection.start, end: selection.end, original: sql },
    };
  }
  const caret = editor.getCaret();
  const span = statementAt(text, caret);
  const sql = span ? text.slice(span.start, span.end) : '';
  return {
    tabId: tab.id,
    sourceId: tab.sourceId,
    schema: tab.schema ?? null,
    sql,
    // Without a selection, generated SQL goes in at the caret.
    target: { tabId: tab.id, start: caret, end: caret, original: '' },
  };
}

/** The error as the AI sees it: SQLSTATE, message, detail, hint and position. */
export function errorText(e: StatementError): string {
  return [
    e.sqlstate ? `ERROR ${e.sqlstate}: ${e.message}` : `ERROR: ${e.message}`,
    e.detail ? `DETAIL: ${e.detail}` : null,
    e.hint ? `HINT: ${e.hint}` : null,
    e.position ? `POSITION: character ${e.position} of the statement` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Explains or fixes a failed statement of a console's current run. */
export function startForError(kind: 'fix' | 'explainError', tabId: string): string | null {
  const run = useExec.getState().runs[tabId];
  const failed = run?.statements.find((s) => s.state === 'failed' && s.error && !s.error.cancelled);
  if (!run || !failed?.error) {
    return 'No failed statement in the last run of this console.';
  }
  const error = errorText(failed.error);
  void useAssistant.getState().start({
    sourceId: run.sourceId,
    schema: run.schema,
    task: kind === 'fix' ? { kind: 'fix', error } : { kind: 'explainError', error },
    sql: failed.sql,
    target:
      kind === 'fix'
        ? {
            tabId,
            start: failed.offset,
            end: failed.offset + failed.sql.length,
            original: failed.sql,
          }
        : null,
  });
  return null;
}
