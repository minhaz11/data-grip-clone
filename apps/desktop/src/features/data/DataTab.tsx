import { Play, RefreshCw, Square, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { connectSource } from '../connections/connectFlow';
import { useWorkspace, type DataTab as DataTabState } from '../../app/workspaceStore';
import { useConnections } from '../connections/connectionsStore';
import { useSessions } from '../connections/sessionsStore';
import { isRunning, useExec } from '../exec/execStore';
import { ResultView } from '../results/ResultView';
import { browseProblem, browseSql, historyKey, useBrowseHistory } from './browse';

/**
 * A table's rows (Open data, M4.8): `SELECT *` with free-form WHERE and ORDER BY text, run in the
 * data source's shared session through the console path, so paging, sorting, editing (M4.2
 * rules) and Stop work the same way.
 */
export function DataTab({ tab }: { tab: DataTabState }) {
  const source = useConnections((s) => s.items.find((c) => c.id === tab.sourceId));
  const connected = useSessions((s) => s.byId[tab.sourceId]?.state === 'connected');
  const run = useExec((s) => s.runs[tab.id]);
  const key = historyKey(tab.sourceId, tab.object);
  const history = useBrowseHistory(useShallow((s) => s.entries[key]));
  const [where, setWhere] = useState(tab.where ?? '');
  const [orderBy, setOrderBy] = useState(tab.orderBy ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const listId = useId();
  const running = isRunning(run);

  function load(nextWhere = where, nextOrderBy = orderBy) {
    if (!running) {
      void openRows(tab, nextWhere, nextOrderBy).then(setProblem);
    }
  }

  // Load once when the tab is shown with its source connected (also after a restart).
  useEffect(() => {
    if (connected && !run) {
      void openRows(tab, tab.where ?? '', tab.orderBy ?? '').then(setProblem);
    }
    // Only when the connection or the absence of a run changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, !run]);

  const statement = run?.statements[0];
  const qualified = `${tab.object.schema}.${tab.object.name}`;

  return (
    <div
      role="tabpanel"
      id="editor-tabpanel"
      aria-labelledby={`tab-${tab.id}`}
      className="flex min-h-0 flex-1 flex-col"
    >
      <form
        aria-label={`Filter ${qualified}`}
        className="flex shrink-0 items-center gap-2 border-b border-border bg-panel px-2 py-1 font-mono text-[12px]"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label htmlFor={`${listId}-where`} className="font-semibold text-muted">
          WHERE
        </label>
        <input
          id={`${listId}-where`}
          value={where}
          onChange={(e) => setWhere(e.target.value)}
          list={`${listId}-where-history`}
          placeholder="e.g. status = 'paid' and total > 100"
          spellCheck={false}
          className="min-w-0 flex-[2] rounded border border-border bg-bg px-2 py-0.5"
        />
        <datalist id={`${listId}-where-history`}>
          {history?.where.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
        <label htmlFor={`${listId}-order`} className="font-semibold text-muted">
          ORDER BY
        </label>
        <input
          id={`${listId}-order`}
          value={orderBy}
          onChange={(e) => setOrderBy(e.target.value)}
          list={`${listId}-order-history`}
          placeholder="e.g. created desc"
          spellCheck={false}
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-0.5"
        />
        <datalist id={`${listId}-order-history`}>
          {history?.orderBy.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
        {running ? (
          <button
            type="button"
            onClick={() => void useExec.getState().cancel(tab.id)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans hover:bg-hover"
          >
            <Square size={12} aria-hidden /> Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!source}
            title="Apply the filter and sort order (Enter)"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans hover:bg-hover disabled:opacity-40"
          >
            {run ? <RefreshCw size={12} aria-hidden /> : <Play size={12} aria-hidden />}
            {run ? 'Reload' : 'Load'}
          </button>
        )}
        <button
          type="button"
          disabled={running || (!where && !orderBy && !tab.where && !tab.orderBy)}
          onClick={() => {
            setWhere('');
            setOrderBy('');
            void load('', '');
          }}
          title="Show all rows in table order"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 font-sans hover:bg-hover disabled:opacity-40"
        >
          <X size={12} aria-hidden /> Clear
        </button>
        {history && (history.where.length > 0 || history.orderBy.length > 0) && (
          <button
            type="button"
            onClick={() => useBrowseHistory.getState().clear(key)}
            title="Forget the filters and sort orders used on this table"
            className="rounded px-1.5 py-0.5 font-sans text-muted hover:bg-hover"
          >
            Clear history
          </button>
        )}
      </form>
      {problem && (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-danger">
          {problem}
        </p>
      )}
      <div className="min-h-0 flex-1 bg-bg">
        {!source ? (
          <p className="p-3 text-muted">This data source no longer exists.</p>
        ) : !run && !connected ? (
          <div className="space-y-2 p-3">
            <p className="text-muted">
              Connect to {source.name} to see the rows of {qualified}.
            </p>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded border border-border px-3 py-1 hover:bg-hover"
            >
              Connect
            </button>
          </div>
        ) : run?.status === 'rejected' ? (
          <p role="alert" className="p-3 text-danger">
            {run.error}
          </p>
        ) : statement?.error ? (
          <div role="alert" className="space-y-1 p-3">
            <p className={statement.error.cancelled ? 'text-muted' : 'text-danger'}>
              {statement.error.cancelled ? 'Cancelled.' : statement.error.message}
            </p>
            {statement.error.detail && <p className="text-muted">{statement.error.detail}</p>}
            {statement.error.hint && <p className="text-muted">Hint: {statement.error.hint}</p>}
          </div>
        ) : statement?.outcome?.type === 'rows' && run ? (
          <ResultView run={run} statement={statement} />
        ) : (
          <p role="status" className="p-3 text-muted">
            Loading {qualified}…
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Runs the data tab's statement (connecting first if needed) and remembers the texts. Resolves to
 * why it did not run, or `null`.
 */
async function openRows(tab: DataTabState, where: string, orderBy: string): Promise<string | null> {
  const source = useConnections.getState().items.find((c) => c.id === tab.sourceId);
  if (!source) {
    return null;
  }
  const sql = browseSql(tab.object, where, orderBy);
  const problem = browseProblem(sql);
  if (problem) {
    return problem;
  }
  if (useSessions.getState().byId[source.id]?.state !== 'connected') {
    const outcome = await connectSource(source);
    if (!outcome.ok) {
      return outcome.error
        ? `Could not connect to "${source.name}": ${outcome.error.message}`
        : null;
    }
  }
  useWorkspace.getState().setDataFilter(tab.id, where.trim(), orderBy.trim());
  useBrowseHistory.getState().remember(historyKey(tab.sourceId, tab.object), where, orderBy);
  await useExec
    .getState()
    .start(tab.id, { sourceId: source.id }, source.name, [{ sql, offset: 0 }], { schema: null });
  return null;
}
