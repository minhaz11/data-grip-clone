import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogHost } from '../../app/dialogs';
import { backend } from '../../ipc/client';
import type { ConnectionProfile, EditTarget, StatementOutcome } from '../../ipc/types';
import { NEW_DRAFT } from '../connections/model';
import { useExec } from '../exec/execStore';
import { EditBar } from './EditBar';
import { NO_EDITS, pendingCount, toChanges, type PendingEdits } from './editsModel';
import { ResultGrid } from './ResultGrid';

type RowsOutcome = Extract<StatementOutcome, { type: 'rows' }>;
const TARGET: EditTarget = {
  schema: 'shop',
  table: 'customers',
  columns: [{ name: 'id', typeName: 'int4' }, { name: 'email', typeName: 'text' }, null],
  key: [0],
};
const OUTCOME: RowsOutcome = {
  type: 'rows',
  columns: [
    { name: 'id', typeName: 'int4' },
    { name: 'email', typeName: 'text' },
    { name: 'shout', typeName: 'text' },
  ],
  rows: [
    ['1', 'a@x.test', 'A'],
    ['2', 'b@x.test', 'B'],
  ],
  totalRows: 2,
  truncated: false,
  cursor: 'quarry_cursor_1',
  edit: { status: 'editable', target: TARGET },
};

afterEach(() => vi.restoreAllMocks());

/** Latest pending edits, captured from the change handler (not during render). */
const captured: { edits: PendingEdits } = { edits: NO_EDITS };
function Harness() {
  const [edits, setEdits] = useState(NO_EDITS);
  return (
    <ResultGrid
      sourceId="src"
      outcome={OUTCOME}
      exportName="r"
      editing={{
        target: TARGET,
        edits,
        busy: false,
        onChange: (f) =>
          setEdits((e) => {
            captured.edits = f(e);
            return captured.edits;
          }),
      }}
    />
  );
}

const cell = (row: number, col: number) => {
  const r = screen.getByRole('grid').querySelector(`[aria-rowindex="${row + 2}"]`);
  return within(r as HTMLElement).getAllByRole('gridcell')[col] as HTMLElement;
};

describe('row editing in the grid', () => {
  it('edits a cell, highlights it, and cancels with Escape without saving', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.dblClick(cell(0, 1));
    const input = screen.getByRole('textbox', { name: 'Cell value' });
    expect(input).toHaveValue('a@x.test');
    await user.clear(input);
    await user.type(input, 'new@x.test{Enter}');
    expect(cell(0, 1)).toHaveTextContent('new@x.test');
    expect(cell(0, 1)).toHaveAttribute('data-changed', 'true');
    expect(toChanges(captured.edits)).toEqual([
      {
        kind: 'update',
        key: ['1'],
        set: [{ column: 1, value: 'new@x.test' }],
        original: [{ column: 1, value: 'a@x.test' }],
      },
    ]);

    await user.dblClick(cell(1, 1));
    await user.type(screen.getByRole('textbox', { name: 'Cell value' }), 'zzz');
    await user.keyboard('{Escape}');
    fireEvent.blur(screen.queryByRole('textbox', { name: 'Cell value' }) ?? document.body); // late blur must not save
    expect(cell(1, 1)).toHaveTextContent('b@x.test');
    expect(pendingCount(captured.edits)).toBe(1);
  });

  it('sets NULL, ignores non-editable columns, deletes and inserts rows', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.dblClick(cell(1, 1));
    await user.click(screen.getByRole('button', { name: 'Set NULL' }));
    expect(cell(1, 1)).toHaveTextContent('NULL');

    await user.dblClick(cell(0, 2)); // computed column
    expect(screen.queryByRole('textbox', { name: 'Cell value' })).not.toBeInTheDocument();

    await user.click(cell(0, 0));
    await user.keyboard('{Delete}');
    expect(screen.getByRole('grid').querySelector('[aria-rowindex="2"]')).toHaveAttribute(
      'data-state',
      'deleted',
    );

    await user.keyboard('{Insert}');
    const inserted = screen.getByRole('grid').querySelector('[aria-rowindex="4"]') as HTMLElement;
    expect(inserted).toHaveAttribute('data-state', 'inserted');
    expect(within(inserted).getAllByText('default')).toHaveLength(3);
    await user.dblClick(cell(2, 1));
    await user.type(screen.getByRole('textbox', { name: 'Cell value' }), 'c@x.test{Enter}');
    expect(toChanges(captured.edits).map((c) => c.kind)).toEqual(['update', 'delete', 'insert']);
    expect(toChanges(captured.edits)[2]).toEqual({
      kind: 'insert',
      values: [{ column: 1, value: 'c@x.test' }],
    });
  });
});

describe('edit bar and submit', () => {
  const source = (
    environment: ConnectionProfile['environment'] = 'development',
  ): ConnectionProfile => ({
    ...NEW_DRAFT,
    environment,
    name: environment === 'production' ? 'Billing' : 'Dev',
    id: 'src',
    passwordSaved: false,
    createdAt: '',
    updatedAt: '',
  });
  const oneEdit: PendingEdits = {
    updates: { '["1"]': { key: ['1'], set: { 1: 'x' }, original: { 1: 'a@x.test' } } },
    deletes: {},
    inserts: [],
  };

  it('explains read-only results', () => {
    render(
      <EditBar
        source={source()}
        target={null}
        reason='"customers" has no primary key.'
        edits={NO_EDITS}
        submitting={false}
        onChange={() => {}}
        onRevert={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(screen.getByText(/Read-only: "customers" has no primary key/)).toBeInTheDocument();
  });

  it('previews the exact statements and bound values', async () => {
    vi.spyOn(backend, 'resultPreviewEdits').mockResolvedValue([
      {
        sql: 'UPDATE "shop"."customers" SET "email" = ($1::text)::text WHERE "id" = ($2::text)::int4',
        params: ["o'neil@x.test", '1'],
      },
    ]);
    const user = userEvent.setup();
    render(
      <EditBar
        source={source()}
        target={TARGET}
        edits={oneEdit}
        submitting={false}
        onChange={() => {}}
        onRevert={() => {}}
        onSubmit={async () => {}}
      />,
    );
    expect(screen.getByText('1 pending change')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Preview/ }));
    const list = await screen.findByRole('list', { name: 'Statements' });
    expect(list).toHaveTextContent('UPDATE "shop"."customers" SET "email"');
    expect(list).toHaveTextContent("$1 = 'o''neil@x.test'");
    expect(list).toHaveTextContent("$2 = '1'");
  });

  it('confirms production submits with the statements', async () => {
    vi.spyOn(backend, 'resultPreviewEdits').mockResolvedValue([
      { sql: 'DELETE FROM "shop"."customers" WHERE "id" = ($1::text)::int4', params: ['1'] },
    ]);
    const onSubmit = vi.fn(async () => {});
    const user = userEvent.setup();
    render(
      <>
        <EditBar
          source={source('production')}
          target={TARGET}
          edits={oneEdit}
          submitting={false}
          onChange={() => {}}
          onRevert={() => {}}
          onSubmit={onSubmit}
        />
        <DialogHost />
      </>,
    );
    await user.click(screen.getByRole('button', { name: /Submit/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Modify production: Billing?' });
    expect(dialog).toHaveTextContent('DELETE FROM "shop"."customers"');
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  });

  it('store: submits, clears edits and re-reads; keeps edits on failure', async () => {
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
              sql: 'select id, email, upper(email) shout from shop.customers',
              state: 'done',
              outcome: OUTCOME,
              edits: oneEdit,
              refinement: { sort: [{ column: 0, descending: true }], filters: [] },
            },
          ],
        },
      },
      view: {},
    });
    const apply = vi
      .spyOn(backend, 'resultApplyEdits')
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce({
        kind: 'db',
        message: 'Change 1 of 1 (update) matched no row.',
        hint: 'Nothing was saved.',
      });
    const refreshed: RowsOutcome = { ...OUTCOME, cursor: 'quarry_cursor_2', edit: undefined };
    const refine = vi.spyOn(backend, 'resultRefine').mockResolvedValue(refreshed);

    await act(() => useExec.getState().submitEdits('t1', 0));
    expect(apply).toHaveBeenCalledWith('src', TARGET, toChanges(oneEdit));
    expect(refine).toHaveBeenCalledWith(
      'src',
      expect.any(String),
      OUTCOME.columns,
      { sort: [{ column: 0, descending: true }], filters: [] },
      'quarry_cursor_1',
    );
    let st = useExec.getState().runs.t1?.statements[0];
    expect(st?.edits).toEqual(NO_EDITS);
    expect(st?.submitted).toBe(1);
    expect(st?.outcome).toMatchObject({ cursor: 'quarry_cursor_2', edit: { status: 'editable' } }); // editability kept

    act(() => useExec.getState().updateEdits('t1', 0, () => oneEdit));
    await act(() => useExec.getState().submitEdits('t1', 0));
    st = useExec.getState().runs.t1?.statements[0];
    expect(st?.edits).toEqual(oneEdit);
    expect(st?.submitError).toBe('Change 1 of 1 (update) matched no row. Nothing was saved.');
  });
});
