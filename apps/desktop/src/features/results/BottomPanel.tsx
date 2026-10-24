import { aiAvailable, useAi } from '../ai/aiStore';
import { startForError } from '../ai/assistantStore';
import clsx from 'clsx';
import { CircleCheck, CircleX, LoaderCircle, Ban, Circle, Pin } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkspace } from '../../app/workspaceStore';
import type { StatementOutcome } from '../../ipc/types';
import { activeEditor } from '../editor/editorHandle';
import { caretPosition } from '../editor/TextareaSqlEditor';
import { isRunning, useExec, type Run, type StatementRun } from '../exec/execStore';
import { ResultView } from './ResultView';

/**
 * Output log and result sets of the active console's latest run, plus results kept from earlier
 * runs (pinned, or every run with the "new tab per run" setting). Data tabs show their grid in
 * the editor area, so here only their output log.
 */
export function BottomPanel() {
  const tabId = useWorkspace((s) => s.activeTabId);
  const isData = useWorkspace((s) => s.tabs.find((t) => t.id === tabId)?.kind === 'data');
  const run = useExec((s) => (tabId ? s.runs[tabId] : undefined));
  const view = useExec((s) => (tabId ? s.view[tabId] : undefined)) ?? 'output';
  const setView = useExec((s) => s.setView);
  const kept = useExec(
    useShallow((s) =>
      (tabId ? (s.kept[tabId] ?? []) : [])
        .map((id) => s.runs[id])
        .filter((r): r is Run => r !== undefined),
    ),
  );
  const results = isData
    ? []
    : (run?.statements.filter((st) => st.outcome?.type === 'rows' && !st.movedTo) ?? []);
  const keptRun = typeof view === 'string' ? kept.find((k) => k.tabId === view) : undefined;

  return (
    <section aria-label="Results" className="flex h-full flex-col bg-panel">
      <div className="flex h-8 shrink-0 items-stretch border-b border-border text-[12px]">
        <div role="tablist" aria-label="Result views" className="flex min-w-0 items-stretch">
          <ViewTab selected={view === 'output'} onClick={() => tabId && setView(tabId, 'output')}>
            Output
          </ViewTab>
          {results.map((st) => (
            <ViewTab
              key={st.index}
              selected={view === st.index}
              onClick={() => tabId && setView(tabId, st.index)}
            >
              Result {st.index + 1}
            </ViewTab>
          ))}
          {kept.map((k) => (
            <ViewTab
              key={k.tabId}
              selected={view === k.tabId}
              onClick={() => tabId && setView(tabId, k.tabId)}
            >
              {k.pinned && <Pin size={11} aria-label="pinned" className="mr-1 inline" />}
              {k.label}
            </ViewTab>
          ))}
        </div>
        {run && <RunSummary run={run} />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-bg">
        {keptRun ? (
          <ResultView run={keptRun} statement={keptRun.statements[0]} pinnable />
        ) : !run ? (
          <div className="flex h-full items-center justify-center text-muted">
            No query has been run.
          </div>
        ) : view === 'output' || typeof view === 'string' || results.length === 0 ? (
          <OutputLog tabId={tabId ?? ''} run={run} />
        ) : (
          <ResultView
            run={run}
            statement={results.find((st) => st.index === view) ?? results[0]}
            pinnable
          />
        )}
      </div>
    </section>
  );
}

function ViewTab({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={clsx(
        'px-3',
        selected
          ? 'bg-bg text-fg shadow-[inset_0_-2px_0_var(--q-accent)]'
          : 'text-muted hover:bg-hover',
      )}
    >
      {children}
    </button>
  );
}

function useElapsed(run: Run): number {
  const [now, setNow] = useState(() => Date.now());
  const live = isRunning(run);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [live]);
  return run.elapsedMs ?? Math.max(0, now - run.startedAt);
}

function RunSummary({ run }: { run: Run }) {
  const elapsed = useElapsed(run);
  // Logged with each run, so the output says whether its changes were committed (REQ-TX-02).
  const mode =
    run.txMode === 'manual' ? ' (manual transaction)' : run.txMode ? ' (auto-commit)' : '';
  const label =
    run.status === 'starting' || run.status === 'running'
      ? `Running on ${run.sourceName}${mode}…`
      : run.status === 'rejected'
        ? 'Not run'
        : `${run.status === 'completed' ? 'Completed' : run.status === 'cancelled' ? 'Cancelled' : 'Failed'} on ${run.sourceName}${mode}`;
  return (
    <span className="ml-auto flex items-center gap-2 px-3 text-muted" aria-live="polite">
      {label}
      {run.status !== 'rejected' && <span className="tabular-nums">{formatMs(elapsed)}</span>}
      {run.longRunning && <span className="font-semibold text-fg">· long-running query</span>}
    </span>
  );
}

function modeText(run: Run): string {
  return run.txMode === 'manual' ? 'manual transaction' : run.txMode ? 'auto-commit' : '';
}

function statusText(run: Run): string {
  switch (run.status) {
    case 'starting':
    case 'running':
      return 'Running';
    case 'rejected':
      return 'Not run';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Failed';
  }
}

/** Whether a statement line matches the output search (statement, error, notices, summary). */
function matches(st: StatementRun, query: string): boolean {
  if (!query) {
    return true;
  }
  const q = query.toLowerCase();
  const texts = [
    st.sql,
    st.error?.message,
    st.outcome ? summary(st.outcome) : undefined,
    ...(st.notices ?? []).map((n) => n.message),
  ];
  return texts.some((t) => t?.toLowerCase().includes(q));
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function summary(o: StatementOutcome): string {
  if (o.type === 'command')
    return o.rowsAffected === 1
      ? '1 row affected'
      : `${o.rowsAffected.toLocaleString()} rows affected`;
  const n = o.totalRows.toLocaleString();
  return o.truncated
    ? `${n} rows (showing first ${o.rows.length.toLocaleString()})`
    : `${n} ${o.totalRows === 1 ? 'row' : 'rows'}`;
}

/**
 * The console's output log (REQ-ERR-01): every run since the last Clear, each with its time,
 * data source, transaction mode and status, then its statements with timings, outcomes,
 * parameter values, notices and errors. Searchable.
 */
function OutputLog({ tabId, run }: { tabId: string; run: Run }) {
  const history = useExec((s) => s.history[tabId]);
  const clearedAt = useExec((s) => s.clearedAt[tabId]) ?? 0;
  const clearOutput = useExec((s) => s.clearOutput);
  const [query, setQuery] = useState('');
  const runs = [...(history ?? []), run].filter((r) => r.startedAt > clearedAt);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1">
        <input
          type="search"
          aria-label="Search output"
          placeholder="Search output"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-64 rounded border border-border bg-bg px-2 py-0.5 text-[12px]"
        />
        <button
          type="button"
          onClick={() => clearOutput(tabId)}
          disabled={runs.length === 0}
          className="rounded px-1.5 py-0.5 text-[12px] hover:bg-hover disabled:opacity-40"
        >
          Clear output
        </button>
      </div>
      <ol
        className="min-h-0 flex-1 divide-y divide-border overflow-auto font-mono text-[12px] select-text"
        aria-label="Statement output"
      >
        {runs.map((r) => {
          const current = r === run;
          const lines = r.statements.filter((st) => matches(st, query));
          if (
            query &&
            lines.length === 0 &&
            !(r.error ?? '').toLowerCase().includes(query.toLowerCase())
          ) {
            return null;
          }
          return (
            <li key={`${r.startedAt}:${r.tabId}`}>
              <p className="bg-panel px-3 py-0.5 font-sans text-[11px] text-muted">
                <time>{new Date(r.startedAt).toLocaleTimeString()}</time>
                {' · '}
                {r.sourceName || 'no data source'}
                {modeText(r) && ` · ${modeText(r)}`}
                {' · '}
                {statusText(r)}
                {r.elapsedMs !== undefined && ` in ${formatMs(r.elapsedMs)}`}
              </p>
              {r.status === 'rejected' && r.error && (
                <p
                  role={current ? 'alert' : undefined}
                  className="px-3 py-1.5 font-sans text-danger"
                >
                  {r.error}
                </p>
              )}
              <ol>
                {lines.map((st) => (
                  <OutputLine key={st.index} st={st} current={current} tabId={tabId} />
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function OutputLine({ st, current, tabId }: { st: StatementRun; current: boolean; tabId: string }) {
  // AI help for errors of the current run, while AI is available (hidden otherwise).
  const aiOn = useAi((s) => aiAvailable(s.status));
  const Icon = {
    pending: Circle,
    running: LoaderCircle,
    done: CircleCheck,
    failed: st.error?.cancelled ? Ban : CircleX,
  }[st.state];
  const firstLine = st.sql.split('\n')[0] ?? '';
  const e = st.error;
  // Where the error is in the console text, as editor line:column.
  const errorOffset = e?.position ? st.offset + e.position - 1 : null;
  // Positions point into the console text only for the current run (it may have changed since).
  const editor = current ? activeEditor() : null;
  const where =
    errorOffset !== null && editor ? caretPosition(editor.getText(), errorOffset) : null;

  return (
    <li className="flex items-start gap-2 px-3 py-1.5">
      <Icon
        size={14}
        aria-label={st.state}
        className={clsx(
          'mt-0.5 shrink-0',
          st.state === 'done' && 'text-success',
          st.state === 'running' && 'animate-spin text-accent',
          st.state === 'failed' && (e?.cancelled ? 'text-muted' : 'text-danger'),
          st.state === 'pending' && 'text-muted',
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate" title={st.sql}>
          {firstLine}
          {st.sql.includes('\n') && ' …'}
        </p>
        {st.params && st.params.length > 0 && (
          <p className="font-sans text-muted">
            Parameters:{' '}
            {st.params
              .map(
                ([name, value]) =>
                  `${/^\d+$/.test(name) ? '$' : ':'}${name} = ${value === null ? 'NULL' : `'${value}'`}`,
              )
              .join(', ')}
          </p>
        )}
        {st.notices?.map((n, i) => (
          <p key={i} className="font-sans">
            <span className={n.severity === 'WARNING' ? 'font-semibold' : 'text-muted'}>
              {n.severity}:
            </span>{' '}
            {n.message}
            {n.detail && <span className="text-muted"> ({n.detail})</span>}
            {n.hint && <span className="text-muted"> Hint: {n.hint}</span>}
          </p>
        ))}
        {st.outcome && <p className="font-sans text-muted">{summary(st.outcome)}</p>}
        {e && (
          <div className="font-sans">
            <p className={e.cancelled ? 'text-muted' : 'text-danger'}>
              {e.cancelled ? 'Cancelled.' : e.message}
              {e.sqlstate && !e.cancelled && (
                <span className="ml-2 font-mono text-[11px] text-muted">SQLSTATE {e.sqlstate}</span>
              )}
              {where && (
                <button
                  type="button"
                  className="ml-2 text-accent underline"
                  onClick={() => editor?.revealOffset(errorOffset ?? 0)}
                >
                  line {where.line}, column {where.column}
                </button>
              )}
            </p>
            {e.detail && <p className="text-muted">{e.detail}</p>}
            {e.hint && <p className="text-muted">Hint: {e.hint}</p>}
            {aiOn && current && !e.cancelled && (
              <p className="mt-1 flex gap-2">
                <button
                  type="button"
                  className="rounded border border-border px-2 py-0.5 hover:bg-hover"
                  onClick={() => startForError('explainError', tabId)}
                >
                  Explain Error
                </button>
                <button
                  type="button"
                  className="rounded border border-border px-2 py-0.5 hover:bg-hover"
                  onClick={() => startForError('fix', tabId)}
                >
                  Fix with AI
                </button>
              </p>
            )}
          </div>
        )}
      </div>
      {st.elapsedMs !== undefined && (
        <span className="shrink-0 tabular-nums text-muted">{formatMs(st.elapsedMs)}</span>
      )}
    </li>
  );
}
