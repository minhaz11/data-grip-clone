import { create } from 'zustand';
import { backend } from '../../ipc/client';
import type {
  ExecEvent,
  JobStatus,
  Refinement,
  SessionKey,
  StatementError,
  StatementOutcome,
  StatementRequest,
  TxMode,
} from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { classify } from '../../lib/sql/classify';
import { useMetadata } from '../explorer/metadataStore';
import { useSettings } from '../../app/settingsStore';
import { useWorkspace } from '../../app/workspaceStore';
import { NO_EDITS, toChanges, type PendingEdits } from '../results/editsModel';

export interface StatementRun {
  index: number;
  offset: number;
  sql: string;
  state: 'pending' | 'running' | 'done' | 'failed';
  outcome?: StatementOutcome;
  error?: StatementError;
  elapsedMs?: number;
  /** Server-side sort/filter currently applied to `outcome`. */
  refinement?: Refinement;
  refining?: boolean;
  refineError?: string;
  /** Unsubmitted row edits. */
  edits?: PendingEdits;
  submitting?: boolean;
  submitError?: string;
  /** Shown after a successful submit until the next edit. */
  submitted?: number;
  /** The result was moved to a kept result (pinned); its cursor belongs to that run now. */
  movedTo?: string;
}

export interface Run {
  tabId: string;
  sourceId: string;
  sourceName: string;
  /** The session the statements ran in; results (cursors) live there. */
  session: SessionKey;
  /** Console schema the run used; re-runs (sort/filter) use it too. */
  schema: string | null;
  /** Transaction mode at the start of the run, shown in the output log. */
  txMode?: TxMode;
  jobId: string | null;
  /** `rejected`: never started (guard, not connected, backend refused). */
  status: 'starting' | 'running' | JobStatus | 'rejected';
  statements: StatementRun[];
  startedAt: number;
  elapsedMs?: number;
  /** Why the run was rejected. */
  error?: string;
  /** When Stop was pressed; after a while the UI offers to drop the connection. */
  cancelRequestedAt?: number;
  /** Kept results (`<tabId>#<n>`): the console they belong to, a label, and whether pinned. */
  keptFrom?: string;
  label?: string;
  pinned?: boolean;
}

/**
 * Which bottom-panel view a console shows: the output log, one result set of the current run
 * (statement index), or a kept result (its run id).
 */
export type ResultView = 'output' | number | string;

/** Unpinned kept results per console ("new tab per run"); older ones are closed. */
export const MAX_KEPT_RESULTS = 5;

/** The console a run belongs to (kept results carry `#<n>` after the console's tab id). */
export function ownerTab(runId: string): string {
  return runId.split('#')[0] ?? runId;
}

interface ExecState {
  runs: Record<string, Run | undefined>;
  view: Record<string, ResultView | undefined>;
  /** Kept result run ids per console tab, oldest first. */
  kept: Record<string, string[] | undefined>;
  start(
    tabId: string,
    session: SessionKey,
    sourceName: string,
    statements: StatementRequest[],
    options: { schema: string | null; txMode?: TxMode },
    onError?: (s: StatementRun) => void,
  ): Promise<void>;
  reject(tabId: string, sourceId: string, sourceName: string, error: string): void;
  cancel(tabId: string): Promise<void>;
  setView(tabId: string, view: ResultView): void;
  /** Re-runs one result with sort/filter; keeps the current result if that fails. */
  refine(tabId: string, index: number, refinement: Refinement): Promise<void>;
  updateEdits(tabId: string, index: number, f: (e: PendingEdits) => PendingEdits): void;
  revertEdits(tabId: string, index: number): void;
  /** Applies pending edits (all or nothing), then re-reads the result. */
  submitEdits(tabId: string, index: number): Promise<void>;
  /** Pins a result of the current run: it stays (with its cursor) through later runs. */
  pin(tabId: string, index: number): string | null;
  /** Pins or unpins a kept result. */
  setPinned(keptId: string, pinned: boolean): void;
  /** Closes a kept result and releases its cursor. */
  closeKept(keptId: string): void;
}

let keptCounter = 0;

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

  /** Moves statement `st` of `run` into a new kept run and returns its id. */
  function keep(run: Run, st: StatementRun, pinned: boolean): string {
    keptCounter += 1;
    const id = `${run.tabId}#${keptCounter}`;
    const time = new Date(run.startedAt).toLocaleTimeString();
    const kept: Run = {
      ...run,
      tabId: id,
      statements: [st],
      keptFrom: run.tabId,
      label: `Result ${st.index + 1} · ${time}`,
      pinned,
    };
    set((s) => ({
      runs: { ...s.runs, [id]: kept },
      kept: { ...s.kept, [run.tabId]: [...(s.kept[run.tabId] ?? []), id] },
    }));
    return id;
  }

  function dropKept(keptId: string) {
    const run = get().runs[keptId];
    releaseCursors(run);
    const owner = ownerTab(keptId);
    set((s) => ({
      runs: { ...s.runs, [keptId]: undefined },
      kept: { ...s.kept, [owner]: (s.kept[owner] ?? []).filter((k) => k !== keptId) },
      view: s.view[owner] === keptId ? { ...s.view, [owner]: 'output' } : s.view,
    }));
  }

  return {
    runs: {},
    view: {},
    kept: {},

    async start(tabId, session, sourceName, statements, options, onError) {
      // The previous results of this console are replaced, or kept as tabs when the setting
      // says so; pinned results always stay.
      let previous = get().runs[tabId];
      const keepPrevious = useSettings.getState().settings.resultTabs === 'new';
      if (previous && keepPrevious) {
        const run = previous;
        previous = {
          ...run,
          statements: run.statements.map((st) =>
            st.outcome?.type === 'rows' && !st.movedTo
              ? { ...st, movedTo: keep(run, st, false) }
              : st,
          ),
        };
      }
      for (const id of get().kept[tabId] ?? []) {
        const k = get().runs[id];
        if (k && !k.pinned && !keepPrevious) {
          dropKept(id);
        }
      }
      const unpinned = (get().kept[tabId] ?? []).filter((id) => !get().runs[id]?.pinned);
      for (const id of unpinned.slice(0, Math.max(0, unpinned.length - MAX_KEPT_RESULTS))) {
        dropKept(id);
      }
      releaseCursors(previous);
      const run: Run = {
        tabId,
        sourceId: session.sourceId,
        sourceName,
        session,
        schema: options.schema,
        txMode: options.txMode,
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
          case 'finished': {
            patch(tabId, (r) => ({ ...r, status: e.status, elapsedMs: e.elapsedMs }));
            // DDL that reached the server may have changed what the explorer shows (REQ-EXPL-16).
            const ran = get().runs[tabId]?.statements.filter((st) => st.state !== 'pending') ?? [];
            if (ran.some((st) => classify(st.sql).kind === 'ddl')) {
              useMetadata.getState().markStale(session.sourceId);
            }
            break;
          }
        }
      };

      try {
        const jobId = await backend.queryExecute(
          { session, statements, ...(options.schema ? { schema: options.schema } : {}) },
          onEvent,
        );
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
            session: { sourceId },
            schema: null,
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
      if (run?.jobId && (run.status === 'running' || run.status === 'starting')) {
        patch(tabId, (r) => ({ ...r, cancelRequestedAt: r.cancelRequestedAt ?? Date.now() }));
        await backend.queryCancel(run.jobId);
      }
    },

    setView: (tabId, view) => set((s) => ({ view: { ...s.view, [tabId]: view } })),

    updateEdits(tabId, index, f) {
      const st = get().runs[tabId]?.statements.find((x) => x.index === index);
      if (!st || st.submitting) return;
      patchStatement(tabId, index, {
        edits: f(st.edits ?? NO_EDITS),
        submitError: undefined,
        submitted: undefined,
      });
    },

    revertEdits: (tabId, index) =>
      patchStatement(tabId, index, { edits: NO_EDITS, submitError: undefined }),

    async submitEdits(tabId, index) {
      const run = get().runs[tabId];
      const st = run?.statements.find((x) => x.index === index);
      const edit = st?.outcome?.type === 'rows' ? st.outcome.edit : undefined;
      if (!run || !st || st.submitting || edit?.status !== 'editable') return;
      const changes = toChanges(st.edits ?? NO_EDITS);
      if (changes.length === 0) return;
      patchStatement(tabId, index, { submitting: true, submitError: undefined });
      try {
        const applied = await backend.resultApplyEdits(run.session, edit.target, changes);
        patchStatement(tabId, index, { submitting: false, edits: NO_EDITS, submitted: applied });
        // Show what the server now holds (same sort/filter, fresh cursor).
        await get().refine(tabId, index, st.refinement ?? { sort: [], filters: [] });
      } catch (e) {
        const err = toAppError(e);
        patchStatement(tabId, index, {
          submitting: false,
          submitError: [err.message, err.hint].filter(Boolean).join(' '),
        });
      }
    },

    pin(tabId, index) {
      const run = get().runs[tabId];
      const st = run?.statements.find((x) => x.index === index);
      if (!run || !st || st.outcome?.type !== 'rows' || st.movedTo || isRunning(run)) {
        return null;
      }
      const id = keep(run, st, true);
      patchStatement(tabId, index, { movedTo: id });
      get().setView(tabId, id);
      return id;
    },

    setPinned(keptId, pinned) {
      patch(keptId, (r) => ({ ...r, pinned }));
    },

    closeKept(keptId) {
      dropKept(keptId);
    },

    async refine(tabId, index, refinement) {
      const run = get().runs[tabId];
      const st = run?.statements.find((x) => x.index === index);
      if (!run || !st || st.outcome?.type !== 'rows' || st.refining) return;
      const cursor = st.outcome.cursor ?? null;
      patchStatement(tabId, index, { refining: true, refineError: undefined });
      try {
        const outcome = await backend.resultRefine(
          run.session,
          st.sql,
          st.outcome.columns,
          refinement,
          cursor,
          run.schema,
        );
        // Sorting/filtering wraps the same query, so the rows' source table (editability) is unchanged.
        const previous = st.outcome.edit;
        const next =
          outcome.type === 'rows' && !outcome.edit && previous
            ? { ...outcome, edit: previous }
            : outcome;
        patchStatement(tabId, index, { outcome: next, refinement, refining: false });
      } catch (e) {
        patchStatement(tabId, index, { refining: false, refineError: toAppError(e).message });
      }
    },
  };
});

export function isRunning(run: Run | undefined): boolean {
  return run?.status === 'starting' || run?.status === 'running';
}

/**
 * Closes the server-side cursors a run holds (each keeps a materialized result on the server).
 * Results moved to a kept run are left to that run.
 */
function releaseCursors(run: Run | undefined) {
  if (!run) {
    return;
  }
  for (const st of run.statements) {
    if (st.outcome?.type === 'rows' && st.outcome.cursor && !st.movedTo) {
      void backend.resultClose(run.session, st.outcome.cursor).catch(() => {});
    }
  }
}

// Closing a console releases its results, kept ones included.
useWorkspace.subscribe((ws, prev) => {
  if (ws.tabs === prev.tabs) {
    return;
  }
  const open = new Set(ws.tabs.map((t) => t.id));
  const runs = useExec.getState().runs;
  for (const id of Object.keys(runs)) {
    if (runs[id] && !open.has(ownerTab(id))) {
      releaseCursors(runs[id]);
      useExec.setState((s) => ({
        runs: { ...s.runs, [id]: undefined },
        view: { ...s.view, [id]: undefined },
        kept: { ...s.kept, [id]: undefined },
      }));
    }
  }
});
