import clsx from 'clsx';
import { CircleCheck, CircleX, LoaderCircle, Ban, Circle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useWorkspace } from '../../app/workspaceStore';
import type { ColumnInfo, StatementOutcome } from '../../ipc/types';
import { activeEditor } from '../editor/editorHandle';
import { caretPosition } from '../editor/TextareaSqlEditor';
import { isRunning, useExec, type Run, type StatementRun } from '../exec/execStore';

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
          <ResultTable statement={results.find((st) => st.index === view) ?? results[0]} />
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
  const label =
    run.status === 'starting' || run.status === 'running'
      ? `Running on ${run.sourceName}…`
      : run.status === 'rejected'
        ? 'Not run'
        : `${run.status === 'completed' ? 'Completed' : run.status === 'cancelled' ? 'Cancelled' : 'Failed'} on ${run.sourceName}`;
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
          st.state === 'done' && 'text-[#3f9d5a]',
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

const NUMERIC = new Set(['int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money', 'oid']);

/** First-page table (M3.2). The virtualized, paged grid replaces it in M3.3. */
function ResultTable({ statement }: { statement: StatementRun | undefined }) {
  const o = statement?.outcome;
  if (!o || o.type !== 'rows') return null;
  const numeric = (c: ColumnInfo) => (c.typeName ? NUMERIC.has(c.typeName) : false);
  return (
    <div className="min-w-max">
      {o.truncated && (
        <p className="sticky left-0 border-b border-border bg-panel-2 px-3 py-1 text-[12px] text-muted">
          Showing the first {o.rows.length.toLocaleString()} of {o.totalRows.toLocaleString()} rows.
        </p>
      )}
      <table className="border-collapse font-mono text-[12px] select-text">
        <thead className="sticky top-0 bg-panel">
          <tr>
            <th className="border-b border-r border-border px-2 py-1 text-right font-normal text-muted">
              #
            </th>
            {o.columns.map((c, i) => (
              <th
                key={i}
                scope="col"
                className="border-b border-r border-border px-2 py-1 text-left font-semibold whitespace-nowrap"
              >
                {c.name}
                {c.typeName && <span className="ml-1.5 font-normal text-muted">{c.typeName}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {o.rows.map((row, r) => (
            <tr key={r} className="hover:bg-hover">
              <td className="border-b border-r border-border px-2 py-0.5 text-right text-muted tabular-nums">
                {r + 1}
              </td>
              {row.map((cell, i) => {
                const col = o.columns[i];
                return (
                  <td
                    key={i}
                    className={clsx(
                      'max-w-[480px] truncate border-b border-r border-border px-2 py-0.5 whitespace-pre',
                      col && numeric(col) && 'text-right tabular-nums',
                    )}
                    title={cell ?? 'NULL'}
                  >
                    {cell === null ? <span className="text-muted italic">NULL</span> : cell}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {o.rows.length === 0 && <p className="px-3 py-2 text-muted">No rows.</p>}
    </div>
  );
}
