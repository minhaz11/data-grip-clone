import clsx from 'clsx';
import { CircleCheck, CircleX, LoaderCircle, Ban, Circle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useWorkspace } from '../../app/workspaceStore';
import type { StatementOutcome } from '../../ipc/types';
import { activeEditor } from '../editor/editorHandle';
import { caretPosition } from '../editor/TextareaSqlEditor';
import { isRunning, useExec, type Run, type StatementRun } from '../exec/execStore';
import { ResultGrid } from './ResultGrid';
import { EditBar } from './EditBar';
import { NO_EDITS, type PendingEdits } from './editsModel';
import { useConnections } from '../connections/connectionsStore';

/** Output log and result sets of the active console's latest run. */
export function BottomPanel() {
  const tabId = useWorkspace((s) => s.activeTabId);
  const run = useExec((s) => (tabId ? s.runs[tabId] : undefined));
  const view = useExec((s) => (tabId ? s.view[tabId] : undefined)) ?? 'output';
  const setView = useExec((s) => s.setView);
  const results = run?.statements.filter((st) => st.outcome?.type === 'rows') ?? [];

  return (
    <section aria-label="Results" className="flex h-full flex-col bg-panel">
      <div
        role="tablist"
        aria-label="Result views"
        className="flex h-8 shrink-0 items-stretch border-b border-border text-[12px]"
      >
        <ViewTab selected={view === 'output'} onClick={() => tabId && setView(tabId, 'output')}>
          Output
        </ViewTab>
        {results.map((st, i) => (
          <ViewTab
            key={st.index}
            selected={view === st.index}
            onClick={() => tabId && setView(tabId, st.index)}
          >
            Result {i + 1}
          </ViewTab>
        ))}
        {run && <RunSummary run={run} />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-bg">
        {!run ? (
          <div className="flex h-full items-center justify-center text-muted">
            No query has been run.
          </div>
        ) : view === 'output' ? (
          <OutputLog run={run} />
        ) : (
          <ResultView run={run} statement={results.find((st) => st.index === view) ?? results[0]} />
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
    </span>
  );
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

function OutputLog({ run }: { run: Run }) {
  if (run.status === 'rejected') {
    return (
      <p role="alert" className="m-3 text-danger select-text">
        {run.error}
      </p>
    );
  }
  return (
    <ol
      className="divide-y divide-border font-mono text-[12px] select-text"
      aria-label="Statement output"
    >
      {run.statements.map((st) => (
        <OutputLine key={st.index} st={st} />
      ))}
    </ol>
  );
}

function OutputLine({ st }: { st: StatementRun }) {
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
  const editor = activeEditor();
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
          </div>
        )}
      </div>
      {st.elapsedMs !== undefined && (
        <span className="shrink-0 tabular-nums text-muted">{formatMs(st.elapsedMs)}</span>
      )}
    </li>
  );
}

function ResultView({ run, statement }: { run: Run; statement: StatementRun | undefined }) {
  const consoleName = useWorkspace(
    (s) => s.tabs.find((t) => t.id === run.tabId)?.console ?? 'result',
  );
  const source = useConnections((s) => s.items.find((c) => c.id === run.sourceId));
  const refine = useExec((s) => s.refine);
  const updateEdits = useExec((s) => s.updateEdits);
  const revertEdits = useExec((s) => s.revertEdits);
  const submitEdits = useExec((s) => s.submitEdits);
  const o = statement?.outcome;
  if (!statement || !o || o.type !== 'rows') return null;

  // Editing needs an editable target and a writable data source; otherwise say why not.
  const target = o.edit?.status === 'editable' && !source?.readOnly ? o.edit.target : null;
  const reason = source?.readOnly
    ? `the data source "${source.name}" is read-only.`
    : o.edit?.status === 'readOnly'
      ? o.edit.reason
      : 'only query results (SELECT …) can be edited.';
  const edits = statement.edits ?? NO_EDITS;
  const onChange = (f: (e: PendingEdits) => PendingEdits) =>
    updateEdits(run.tabId, statement.index, f);

  return (
    <div className="flex h-full flex-col">
      <EditBar
        source={source}
        session={run.session}
        target={target}
        reason={reason}
        edits={edits}
        submitting={statement.submitting ?? false}
        submitError={statement.submitError}
        submitted={statement.submitted}
        onChange={onChange}
        onRevert={() => revertEdits(run.tabId, statement.index)}
        onSubmit={() => submitEdits(run.tabId, statement.index)}
      />
      <div className="min-h-0 flex-1">
        {/* Re-keyed per result (cursor), so each re-run starts with a fresh page cache and scroll position. */}
        <ResultGrid
          key={`${statement.index}:${o.cursor ?? 'capped'}:${run.startedAt}`}
          session={run.session}
          outcome={o}
          exportName={`${consoleName}_result_${statement.index + 1}`}
          // Only cursor-backed query results can be re-run with sort/filter.
          onRefine={o.cursor ? (r) => void refine(run.tabId, statement.index, r) : undefined}
          refinement={statement.refinement}
          refining={statement.refining}
          refineError={statement.refineError}
          widthsKey={`${run.tabId}:${run.startedAt}:${statement.index}`}
          editing={
            target ? { target, edits, busy: statement.submitting ?? false, onChange } : undefined
          }
        />
      </div>
    </div>
  );
}
