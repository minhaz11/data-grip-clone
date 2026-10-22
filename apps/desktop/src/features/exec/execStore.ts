import { create } from 'zustand';
import { backend } from '../../ipc/client';
import type {
  ExecEvent,
  JobStatus,
  StatementError,
  StatementOutcome,
  StatementRequest,
} from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { useWorkspace } from '../../app/workspaceStore';

export interface StatementRun {
  index: number;
  offset: number;
  sql: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  outcome?: StatementOutcome;
  error?: StatementError;
  elapsedMs?: number;
}

export interface Run {
  tabId: string;
  sourceId: string;
  sourceName: string;
  jobId: string | null;
  /** `rejected`: never started (guard, not connected, backend refused). */
  status: 'starting' | 'running' | JobStatus | 'rejected';
  statements: StatementRun[];
  startedAt: number;
  elapsedMs?: number;
  /** Why the run was rejected. */
  error?: string;
}

/** Which bottom-panel view a console shows: the output log or one result set. */
export type ResultView = 'output' | number;

interface ExecState {
  runs: Record<string, Run | undefined>;
  view: Record<string, ResultView | undefined>;
  start(
    tabId: string,
    sourceId: string,
    sourceName: string,
    statements: StatementRequest[],
    onError?: (s: StatementRun) => void,
  ): Promise<void>;
  reject(tabId: string, sourceId: string, sourceName: string, error: string): void;
  cancel(tabId: string): Promise<void>;
  setView(tabId: string, view: ResultView): void;
}

export const useExec = create<ExecState>((set, get) => {
  const patch = (tabId: string, f: (r: Run) => Run) =>
    set((s) => {
      const r = s.runs[tabId];
      return r ? { runs: { ...s.runs, [tabId]: f(r) } } : s;
    });
  const patchStatement = (tabId: string, index: number, p: Partial<StatementRun>) =>
    patch(tabId, (r) => ({
      ...r,
      statements: r.statements.map((st) => (st.index === index ? { ...st, ...p } : st)),
    }));

  return {
    runs: {},
    view: {},

    async start(tabId, sourceId, sourceName, statements, onError) {
      releaseCursors(get().runs[tabId]); // the previous results of this console are replaced
      const run: Run = {
        tabId,
        sourceId,
        sourceName,
        jobId: null,
        status: 'starting',
        statements: statements.map((s, index) => ({
          index,
          offset: s.offset,
          sql: s.sql,
          state: 'pending',
        })),
        startedAt: Date.now(),
      };
      set((s) => ({ runs: { ...s.runs, [tabId]: run }, view: { ...s.view, [tabId]: 'output' } }));

      const onEvent = (e: ExecEvent) => {
        // Events can arrive before `queryExecute` resolves; they are keyed by tab, not job id.
        switch (e.event) {
          case 'statementStarted':
            patch(tabId, (r) => ({ ...r, status: 'running' }));
            patchStatement(tabId, e.index, { state: 'running' });
            break;
          case 'statementDone': {
            patchStatement(tabId, e.index, {
              state: 'done',
              outcome: e.outcome,
              elapsedMs: e.elapsedMs,
            });
            // Show the first result set as soon as it exists.
            if (e.outcome.type === 'rows' && get().view[tabId] === 'output') {
              const firstRows = get().runs[tabId]?.statements.find(
                (st) => st.outcome?.type === 'rows',
              );
              if (firstRows?.index === e.index) get().setView(tabId, e.index);
            }
            break;
          }
          case 'statementFailed': {
            patchStatement(tabId, e.index, {
              state: 'failed',
              error: e.error,
              elapsedMs: e.elapsedMs,
            });
            const failed = get().runs[tabId]?.statements.find((st) => st.index === e.index);
            if (failed && !e.error.cancelled) onError?.(failed);
            get().setView(tabId, 'output');
            break;
          }
          case 'finished':
            patch(tabId, (r) => ({ ...r, status: e.status, elapsedMs: e.elapsedMs }));
            break;
        }
      };

      try {
        const jobId = await backend.queryExecute({ sourceId, statements }, onEvent);
        patch(tabId, (r) => ({ ...r, jobId }));
      } catch (e) {
        patch(tabId, (r) => ({ ...r, status: 'rejected', error: toAppError(e).message }));
      }
    },

    reject(tabId, sourceId, sourceName, error) {
      set((s) => ({
        runs: {
          ...s.runs,
          [tabId]: {
            tabId,
            sourceId,
            sourceName,
            jobId: null,
            status: 'rejected',
            statements: [],
            startedAt: Date.now(),
            error,
          },
        },
        view: { ...s.view, [tabId]: 'output' },
      }));
    },

    async cancel(tabId) {
      const run = get().runs[tabId];
      if (run?.jobId && (run.status === 'running' || run.status === 'starting'))
        await backend.queryCancel(run.jobId);
    },

    setView: (tabId, view) => set((s) => ({ view: { ...s.view, [tabId]: view } })),
  };
});

export function isRunning(run: Run | undefined): boolean {
  return run?.status === 'starting' || run?.status === 'running';
}

/** Closes the server-side cursors a run holds (each keeps a materialized result on the server). */
function releaseCursors(run: Run | undefined) {
  if (!run) return;
  for (const st of run.statements) {
    if (st.outcome?.type === 'rows' && st.outcome.cursor)
      void backend.resultClose(run.sourceId, st.outcome.cursor).catch(() => {});
  }
}

// Closing a console releases its results.
useWorkspace.subscribe((ws, prev) => {
  if (ws.tabs === prev.tabs) return;
  const open = new Set(ws.tabs.map((t) => t.id));
  const runs = useExec.getState().runs;
  for (const id of Object.keys(runs)) {
    if (!open.has(id)) {
      releaseCursors(runs[id]);
      useExec.setState((s) => ({
        runs: { ...s.runs, [id]: undefined },
        view: { ...s.view, [id]: undefined },
      }));
    }
  }
});
