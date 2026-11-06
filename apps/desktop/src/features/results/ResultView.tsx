import { Pin, PinOff, X } from 'lucide-react';
import { isConsole, useWorkspace } from '../../app/workspaceStore';
import type { TableName } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { ownerTab, useExec, type Run, type StatementRun } from '../exec/execStore';
import { signature } from './columnLayout';
import { EditBar } from './EditBar';
import { NO_EDITS, type PendingEdits } from './editsModel';
import { ResultGrid } from './ResultGrid';

/**
 * One result set with its edit bar: in the bottom panel (console results, kept results) and in
 * data tabs. Column layouts are stored in the tab the result belongs to.
 */
export function ResultView({
  run,
  statement,
  pinnable = false,
}: {
  run: Run;
  statement: StatementRun | undefined;
  /** Offer Pin (current console results) or Unpin and Close (kept results). */
  pinnable?: boolean;
}) {
  const owner = ownerTab(run.tabId);
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === owner));
  const setGridLayout = useWorkspace((s) => s.setGridLayout);
  const source = useConnections((s) => s.items.find((c) => c.id === run.sourceId));
  const refine = useExec((s) => s.refine);
  const updateEdits = useExec((s) => s.updateEdits);
  const revertEdits = useExec((s) => s.revertEdits);
  const submitEdits = useExec((s) => s.submitEdits);
  const pin = useExec((s) => s.pin);
  const setPinned = useExec((s) => s.setPinned);
  const closeKept = useExec((s) => s.closeKept);
  const o = statement?.outcome;
  if (!statement || !o || o.type !== 'rows') {
    return null;
  }

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

  const baseName = isConsole(tab) ? tab.console : tab?.kind === 'data' ? tab.object.name : 'result';
  const sqlTable: TableName | undefined =
    o.edit?.status === 'editable'
      ? { schema: o.edit.target.schema, name: o.edit.target.table }
      : tab?.kind === 'data'
        ? { schema: tab.object.schema, name: tab.object.name }
        : undefined;
  const layoutKey = signature(o.columns);
  const layout = isConsole(tab) || tab?.kind === 'data' ? tab.gridLayouts?.[layoutKey] : undefined;

  const kept = run.keptFrom !== undefined;
  const leading = pinnable ? (
    kept ? (
      <>
        <button
          type="button"
          onClick={() => setPinned(run.tabId, !run.pinned)}
          aria-pressed={run.pinned ?? false}
          title={
            run.pinned
              ? 'Unpin: the next run may replace this result'
              : 'Pin: keep this result through later runs'
          }
          className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-fg hover:bg-hover"
        >
          {run.pinned ? <PinOff size={12} aria-hidden /> : <Pin size={12} aria-hidden />}
          {run.pinned ? 'Unpin' : 'Pin'}
        </button>
        <button
          type="button"
          onClick={() => closeKept(run.tabId)}
          title="Close this result and release it on the server"
          className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-fg hover:bg-hover"
        >
          <X size={12} aria-hidden /> Close
        </button>
      </>
    ) : (
      <button
        type="button"
        onClick={() => pin(run.tabId, statement.index)}
        title="Pin: keep this result as its own tab through later runs"
        className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-fg hover:bg-hover"
      >
        <Pin size={12} aria-hidden /> Pin
      </button>
    )
  ) : null;

  return (
    <div className="flex h-full flex-col">
      {/* Re-keyed per result (cursor), so each re-run starts with a fresh page cache and scroll position. */}
      <ResultGrid
        key={`${statement.index}:${o.cursor ?? 'capped'}:${run.startedAt}`}
        session={run.session}
        outcome={o}
        exportName={`${baseName}_result_${statement.index + 1}`}
        // Only cursor-backed query results can be re-run with sort/filter.
        onRefine={o.cursor ? (r) => void refine(run.tabId, statement.index, r) : undefined}
        refinement={statement.refinement}
        refining={statement.refining}
        refineError={statement.refineError}
        widthsKey={`${run.tabId}:${run.startedAt}:${statement.index}`}
        editing={
          target ? { target, edits, busy: statement.submitting ?? false, onChange } : undefined
        }
        layout={layout}
        onLayoutChange={(next) => setGridLayout(owner, layoutKey, next)}
        sqlTable={sqlTable}
        editBar={(actions) => (
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
            actions={target ? actions : undefined}
            leading={leading}
          />
        )}
      />
    </div>
  );
}
