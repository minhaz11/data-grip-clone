import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetHydrationForTests, snapshot, useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { Cell, EditTarget, StatementOutcome } from '../../ipc/types';
import { useExec, type Run } from '../exec/execStore';
import { signature } from './columnLayout';
import { EditBar } from './EditBar';
import { NO_EDITS, toChanges, type PendingEdits } from './editsModel';
import { PAGE_SIZE } from './gridModel';
import { MAX_PAGES_IN_FLIGHT } from './pageLoader';
import { ResultGrid } from './ResultGrid';
import { ResultView } from './ResultView';

type RowsOutcome = Extract<StatementOutcome, { type: 'rows' }>;

const COLUMNS = [
  { name: 'g', typeName: 'int4' },
  { name: 'h', typeName: 'text' },
];
const rowsAt = (offset: number, limit: number, total: number): Cell[][] =>
  Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => [
    String(offset + i + 1),
    i % 7 === 0 ? null : `h${offset + i + 1}`,
  ]);

function result(total: number, columns = COLUMNS): RowsOutcome {
  return {
    type: 'rows',
    columns,
    rows: rowsAt(0, PAGE_SIZE, total),
    totalRows: total,
    truncated: total > PAGE_SIZE,
    cursor: 'cur',
  };
}

let write: ReturnType<typeof vi.fn>;
/** A clipboard to assert on; call again after `userEvent.setup()`, which installs its own. */
function stubClipboard() {
  write = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: write },
    configurable: true,
  });
}
beforeEach(stubClipboard);
afterEach(() => vi.restoreAllMocks());

const grid = () => screen.getByRole('grid', { name: 'Result rows' });
const cell = (row: number, col: number) => {
  const r = grid().querySelector(`[aria-rowindex="${row + 2}"]`);
  return within(r as HTMLElement).getAllByRole('gridcell')[col] as HTMLElement;
};
const selectedTexts = () =>
  within(grid())
    .getAllByRole('gridcell')
    .filter((c) => c.getAttribute('aria-selected') === 'true')
    .map((c) => c.textContent);
const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent);

describe('range selection', () => {
  it('extends with Shift+arrows, summarizes numbers and copies as TSV', async () => {
    const format = vi.spyOn(backend, 'resultFormat').mockResolvedValue('1\n2\n3');
    render(<ResultGrid session={{ sourceId: 'src' }} outcome={result(3)} exportName="r" />);
    act(() => grid().focus());
    await userEvent.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}');
    expect(selectedTexts()).toEqual(['1', '2', '3']);
    const status = screen.getByRole('status', { name: 'Selection summary' });
    expect(status).toHaveTextContent('3 × 1');
    expect(status).toHaveTextContent('Count 3 · Sum 6 · Avg 2 · Min 1 · Max 3');

    await userEvent.keyboard('{Control>}c{/Control}');
    await waitFor(() => expect(write).toHaveBeenCalledWith('1\n2\n3'));
    expect(format).toHaveBeenCalledWith([COLUMNS[0]], [['1'], ['2'], ['3']], 'tsv', {
      nullText: null,
      quoteAll: false,
      header: false,
    });

    await userEvent.keyboard('{Control>}a{/Control}');
    expect(selectedTexts()).toHaveLength(6);
    // Text cells count but do not sum; NULL is not counted.
    expect(screen.getByRole('status', { name: 'Selection summary' })).toHaveTextContent(
      'Count 5 · Sum 6',
    );
  });

  it('selects with the mouse: drag, Shift+click and the row number', () => {
    render(<ResultGrid session={{ sourceId: 'src' }} outcome={result(5)} exportName="r" />);
    fireEvent.mouseDown(cell(1, 1));
    fireEvent.mouseEnter(cell(3, 1));
    fireEvent.mouseUp(window);
    expect(selectedTexts()).toEqual(['h2', 'h3', 'h4']);
    fireEvent.mouseEnter(cell(4, 1)); // not dragging any more
    expect(selectedTexts()).toHaveLength(3);
    fireEvent.mouseDown(cell(4, 0), { shiftKey: true });
    expect(selectedTexts()).toEqual(['2', 'h2', '3', 'h3', '4', 'h4', '5', 'h5']);
    const rowNumber = grid().querySelector('[aria-rowindex="3"]')?.firstElementChild;
    fireEvent.mouseDown(rowNumber as Element);
    expect(selectedTexts()).toEqual(['2', 'h2']);
  });

  it('copies a selection over unloaded rows with at most two page requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const page = vi
      .spyOn(backend, 'resultPage')
      .mockImplementation(async (_s, _c, offset, limit) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return rowsAt(offset, limit, 3000);
      });
    const format = vi.spyOn(backend, 'resultFormat').mockResolvedValue('[...]');
    const user = userEvent.setup();
    stubClipboard();
    render(<ResultGrid session={{ sourceId: 'src' }} outcome={result(3000)} exportName="r" />);
    act(() => grid().focus());
    await user.keyboard('{Control>}a{/Control}');
    // Aggregates cover loaded rows only and say so.
    expect(screen.getByRole('status', { name: 'Selection summary' })).toHaveTextContent(
      '(loaded rows only)',
    );
    await user.click(screen.getByRole('button', { name: /Copy/ }));
    const dialog = screen.getByRole('dialog', { name: 'Copy rows' });
    expect(within(dialog).getByLabelText(/Selection \(3,000 × 2 cells\)/)).toBeChecked();
    await user.selectOptions(within(dialog).getByLabelText('Format'), 'json');
    await user.click(within(dialog).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(write).toHaveBeenCalledWith('[...]'));
    expect(peak).toBeLessThanOrEqual(MAX_PAGES_IN_FLIGHT);
    expect(page.mock.calls.map((c) => c[2]).sort((a, b) => a - b)).toEqual([
      500, 1000, 1500, 2000, 2500,
    ]);
    const [cols, rows, fmt] = format.mock.calls[0] ?? [];
    expect(cols).toEqual(COLUMNS);
    expect(rows).toHaveLength(3000);
    expect(rows?.[2999]).toEqual(['3000', 'h3000']);
    expect(fmt).toBe('json');
    expect(screen.getByText('Copied 3,000 rows')).toBeInTheDocument();
  });
});

// ----- Column layout, stored in the tab -----

const THREE = [
  { name: 'a', typeName: 'int4' },
  { name: 'b', typeName: 'text' },
  { name: 'c', typeName: 'text' },
];

function runWith(cursor: string, startedAt: number): Run {
  return {
    tabId: 't1',
    sourceId: 'src',
    sourceName: 'Dev',
    session: { sourceId: 'src' },
    schema: null,
    jobId: 'j',
    status: 'completed',
    startedAt,
    statements: [
      {
        index: 0,
        offset: 0,
        sql: 'select a, b, c from t',
        state: 'done',
        outcome: {
          type: 'rows',
          columns: THREE,
          rows: [['1', 'x', 'y']],
          totalRows: 1,
          truncated: false,
          cursor,
        },
      },
    ],
  };
}

function View() {
  const run = useExec((s) => s.runs.t1);
  return run ? <ResultView run={run} statement={run.statements[0]} /> : null;
}

async function restoreWorkspace(
  state: Parameters<ReturnType<typeof useWorkspace.getState>['hydrate']>[0],
) {
  resetHydrationForTests();
  useWorkspace.setState({ tabs: [], activeTabId: null, hydrated: false });
  await act(() => useWorkspace.getState().hydrate(state));
}

describe('column layout', () => {
  it('hides and reorders columns; both survive a re-run and an app restart', async () => {
    vi.spyOn(backend, 'consoleRead').mockResolvedValue('select a, b, c from t');
    await restoreWorkspace({
      layout: {},
      panels: { explorerCollapsed: false, bottomCollapsed: false },
      tabs: [{ id: 't1', console: 'console', sourceId: 'src' }],
      activeTabId: 't1',
    });
    useExec.setState({ runs: { t1: runWith('c1', 1) }, view: {}, kept: {} });
    const user = userEvent.setup();
    const { unmount } = render(<View />);
    expect(headers()).toEqual(['aint4', 'btext', 'ctext']);

    // Hide b from the Columns menu, then drag c in front of a.
    await user.click(screen.getByRole('button', { name: /Columns/ }));
    await user.click(screen.getByRole('menuitem', { name: 'Hide b' }));
    expect(headers()).toEqual(['aint4', 'ctext']);
    expect(screen.getByText(/1 hidden column/)).toBeInTheDocument();
    const [a, c] = screen.getAllByRole('columnheader') as [HTMLElement, HTMLElement];
    fireEvent.dragStart(c, { dataTransfer: {} });
    fireEvent.dragOver(a, { dataTransfer: {} });
    fireEvent.drop(a, { dataTransfer: {} });
    expect(headers()).toEqual(['ctext', 'aint4']);
    const tab = useWorkspace.getState().tabs[0];
    expect(tab && 'gridLayouts' in tab && tab.gridLayouts?.[signature(THREE)]).toEqual({
      order: [2, 0, 1],
      hidden: [1],
    });

    // A re-run with the same columns (new cursor) keeps the layout.
    act(() => useExec.setState({ runs: { t1: runWith('c2', 2) } }));
    expect(headers()).toEqual(['ctext', 'aint4']);

    // After an app restart (results are gone), running the query again restores the layout
    // from the saved workspace.
    const saved = JSON.parse(JSON.stringify(snapshot(useWorkspace.getState())));
    unmount();
    await restoreWorkspace(saved);
    expect(useExec.getState().runs.t1).toBeUndefined();
    useExec.setState({ runs: { t1: runWith('c3', 3) } });
    render(<View />);
    expect(headers()).toEqual(['ctext', 'aint4']);

    // The header menu shows everything again; the default layout is not stored.
    fireEvent.contextMenu(screen.getAllByRole('columnheader')[0] as HTMLElement);
    await user.click(screen.getByRole('menuitem', { name: 'Reset column layout' }));
    expect(headers()).toEqual(['aint4', 'btext', 'ctext']);
    const after = useWorkspace.getState().tabs[0];
    expect(after && 'gridLayouts' in after ? after.gridLayouts : undefined).toEqual({});
  });
});

// ----- Edit actions over the selection -----

const TARGET: EditTarget = {
  schema: 'shop',
  table: 'customers',
  columns: [
    { name: 'id', typeName: 'int4' },
    { name: 'email', typeName: 'text' },
  ],
  key: [0],
};
const EDITABLE: RowsOutcome = {
  type: 'rows',
  columns: [
    { name: 'id', typeName: 'int4' },
    { name: 'email', typeName: 'text' },
  ],
  rows: [
    ['1', 'a@x.test'],
    ['2', 'b@x.test'],
  ],
  totalRows: 2,
  truncated: false,
  cursor: 'cur',
  edit: { status: 'editable', target: TARGET },
};

const captured: { edits: PendingEdits } = { edits: NO_EDITS };
function Editable() {
  const [edits, setEdits] = useState(NO_EDITS);
  const onChange = (f: (e: PendingEdits) => PendingEdits) =>
    setEdits((e) => {
      captured.edits = f(e);
      return captured.edits;
    });
  return (
    <ResultGrid
      session={{ sourceId: 'src' }}
      outcome={EDITABLE}
      exportName="r"
      editing={{ target: TARGET, edits, busy: false, onChange }}
      editBar={(actions) => (
        <EditBar
          source={undefined}
          session={{ sourceId: 'src' }}
          target={TARGET}
          edits={edits}
          submitting={false}
          onChange={onChange}
          onRevert={() => {}}
          onSubmit={async () => {}}
          actions={actions}
        />
      )}
    />
  );
}

describe('edit actions over the selection', () => {
  it('sets DEFAULT, clones rows without their key and reverts selected rows', async () => {
    const user = userEvent.setup();
    render(<Editable />);
    fireEvent.mouseDown(cell(0, 1));
    await user.click(screen.getByRole('button', { name: 'Set DEFAULT' }));
    expect(within(cell(0, 1)).getByText('default')).toBeInTheDocument();
    expect(toChanges(captured.edits)).toEqual([
      {
        kind: 'update',
        key: ['1'],
        set: [],
        original: [{ column: 1, value: 'a@x.test' }],
        defaults: [1],
      },
    ]);

    fireEvent.mouseDown(cell(0, 0));
    fireEvent.mouseDown(cell(1, 0), { shiftKey: true });
    await user.click(screen.getByRole('button', { name: /Clone/ }));
    expect(captured.edits.inserts.map((r) => r.values)).toEqual([
      { 1: 'a@x.test' },
      { 1: 'b@x.test' },
    ]);
    expect(grid()).toHaveAttribute('aria-rowcount', '5');

    // Select row 1 and the two new rows, then revert them.
    fireEvent.mouseDown(cell(0, 0));
    fireEvent.mouseDown(cell(3, 1), { shiftKey: true });
    await user.click(screen.getByRole('button', { name: /Revert selected/ }));
    expect(toChanges(captured.edits)).toEqual([]);
  });

  it('marks every selected row for deletion with Delete', async () => {
    render(<Editable />);
    fireEvent.mouseDown(cell(0, 0));
    fireEvent.mouseDown(cell(1, 1), { shiftKey: true });
    act(() => grid().focus());
    await userEvent.keyboard('{Delete}');
    expect(toChanges(captured.edits)).toEqual([
      { kind: 'delete', key: ['1'] },
      { kind: 'delete', key: ['2'] },
    ]);
  });
});
