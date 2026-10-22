import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backend } from '../../ipc/client';
import type { Refinement, StatementOutcome } from '../../ipc/types';
import { useExec } from '../exec/execStore';
import { ResultGrid } from './ResultGrid';

type RowsOutcome = Extract<StatementOutcome, { type: 'rows' }>;
const OUTCOME: RowsOutcome = {
  type: 'rows',
  columns: [
    { name: 'id', typeName: 'int4' },
    { name: 'email', typeName: 'text' },
  ],
  rows: [
    ['1', 'a@x.test'],
    ['2', null],
  ],
  totalRows: 2,
  truncated: false,
  cursor: 'quarry_cursor_1',
};

afterEach(() => vi.restoreAllMocks());

function renderGrid(refinement: Refinement = { sort: [], filters: [] }) {
  const onRefine = vi.fn();
  const utils = render(
    <ResultGrid
      sourceId="src"
      outcome={OUTCOME}
      exportName="r"
      onRefine={onRefine}
      refinement={refinement}
    />,
  );
  const header = (name: string) =>
    screen.getAllByRole('columnheader').find((h) => h.textContent?.startsWith(name)) as HTMLElement;
  return { ...utils, onRefine, header };
}

describe('server-side sort and filter UI', () => {
  it('sorts from header clicks: plain cycles, Shift adds a key', async () => {
    const user = userEvent.setup();
    const { onRefine, header, rerender } = renderGrid();
    expect(header('id')).toHaveAttribute('aria-sort', 'none');
    await user.click(within(header('email')).getByRole('button', { name: 'email' }));
    expect(onRefine).toHaveBeenLastCalledWith({
      sort: [{ column: 1, descending: false }],
      filters: [],
    });

    rerender(
      <ResultGrid
        sourceId="src"
        outcome={OUTCOME}
        exportName="r"
        onRefine={onRefine}
        refinement={{ sort: [{ column: 1, descending: false }], filters: [] }}
      />,
    );
    expect(header('email')).toHaveAttribute('aria-sort', 'ascending');
    await user.click(within(header('email')).getByRole('button', { name: 'email' }));
    expect(onRefine).toHaveBeenLastCalledWith({
      sort: [{ column: 1, descending: true }],
      filters: [],
    });

    await user.keyboard('{Shift>}');
    await user.click(within(header('id')).getByRole('button', { name: 'id' }));
    await user.keyboard('{/Shift}');
    expect(onRefine).toHaveBeenLastCalledWith({
      sort: [
        { column: 1, descending: false },
        { column: 0, descending: false },
      ],
      filters: [],
    });
  });

  it('adds and removes filters, hiding the value for NULL tests', async () => {
    const user = userEvent.setup();
    const { onRefine, rerender } = renderGrid();
    const bar = screen.getByRole('group', { name: 'Filters' });
    await user.click(within(bar).getByRole('button', { name: 'Filter' }));
    await user.selectOptions(within(bar).getByLabelText('Filter column'), 'email');
    await user.selectOptions(within(bar).getByLabelText('Filter operator'), 'contains');
    expect(within(bar).getByRole('button', { name: 'Apply' })).toBeDisabled();
    // jsdom: the panel library is not mounted here, so typing works directly.
    await user.type(within(bar).getByLabelText('Filter value'), '@x');
    await user.click(within(bar).getByRole('button', { name: 'Apply' }));
    expect(onRefine).toHaveBeenLastCalledWith({
      sort: [],
      filters: [{ column: 1, op: 'contains', value: '@x' }],
    });

    rerender(
      <ResultGrid
        sourceId="src"
        outcome={OUTCOME}
        exportName="r"
        onRefine={onRefine}
        refinement={{ sort: [], filters: [{ column: 1, op: 'contains', value: '@x' }] }}
      />,
    );
    expect(screen.getByText(/filtered \(1\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove filter on email' }));
    expect(onRefine).toHaveBeenLastCalledWith({ sort: [], filters: [] });
    // The grid is controlled: the parent applies the change and re-renders it.
    rerender(
      <ResultGrid
        sourceId="src"
        outcome={OUTCOME}
        exportName="r"
        onRefine={onRefine}
        refinement={{ sort: [], filters: [] }}
      />,
    );

    await user.click(within(bar).getByRole('button', { name: 'Filter' }));
    await user.selectOptions(within(bar).getByLabelText('Filter operator'), 'is_null');
    expect(within(bar).queryByLabelText('Filter value')).not.toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Apply' }));
    expect(onRefine).toHaveBeenLastCalledWith({
      sort: [],
      filters: [{ column: 1, op: 'is_null', value: null }],
    });
  });

  it('offers no sort controls for results that cannot be re-run', () => {
    render(
      <ResultGrid sourceId="src" outcome={{ ...OUTCOME, cursor: undefined }} exportName="r" />,
    );
    expect(screen.queryByRole('group', { name: 'Filters' })).not.toBeInTheDocument();
    expect(
      within(screen.getAllByRole('columnheader')[0] as HTMLElement).queryByRole('button'),
    ).toBeNull();
  });

  it('store: replaces the result on success and keeps it on failure', async () => {
    useExec.setState({
      runs: {
        t1: {
          tabId: 't1',
          sourceId: 'src',
          sourceName: 'Dev',
          jobId: 'j',
          status: 'completed',
          startedAt: 1,
          statements: [
            {
              index: 0,
              offset: 0,
              sql: 'select id, email from users',
              state: 'done',
              outcome: OUTCOME,
            },
          ],
        },
      },
      view: {},
    });
    const sorted: RowsOutcome = {
      ...OUTCOME,
      rows: [
        ['2', null],
        ['1', 'a@x.test'],
      ],
      cursor: 'quarry_cursor_2',
    };
    const refine = vi
      .spyOn(backend, 'resultRefine')
      .mockResolvedValueOnce(sorted)
      .mockRejectedValueOnce({
        kind: 'db',
        message: 'invalid input syntax for type integer: "abc"',
      });
    const r1: Refinement = { sort: [{ column: 0, descending: true }], filters: [] };
    await useExec.getState().refine('t1', 0, r1);
    expect(refine).toHaveBeenCalledWith(
      'src',
      'select id, email from users',
      OUTCOME.columns,
      r1,
      'quarry_cursor_1',
    );
    let st = useExec.getState().runs.t1?.statements[0];
    expect(st?.outcome).toEqual(sorted);
    expect(st?.refinement).toEqual(r1);

    await useExec
      .getState()
      .refine('t1', 0, { sort: [], filters: [{ column: 0, op: 'eq', value: 'abc' }] });
    st = useExec.getState().runs.t1?.statements[0];
    await waitFor(() => expect(st?.refining).toBe(false));
    expect(st?.outcome).toEqual(sorted); // previous result stays visible
    expect(st?.refinement).toEqual(r1);
    expect(st?.refineError).toContain('invalid input syntax');
  });
});
