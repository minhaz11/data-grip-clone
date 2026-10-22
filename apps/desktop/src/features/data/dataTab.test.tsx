import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { snapshot, useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { ConnectionDraft, ExecRequest } from '../../ipc/types';
import { registerExplorerHarness, setup } from '../explorer/explorerTestKit';
import { browseProblem, browseSql } from './browse';

registerExplorerHarness();

describe('browse statement', () => {
  const orders = { schema: 'shop', name: 'Order Items', objectType: 'table' as const };

  it('quotes the table and wraps the filter so a comment cannot swallow the parenthesis', () => {
    expect(browseSql(orders, '', '')).toBe('SELECT * FROM shop."Order Items"');
    const sql = browseSql(orders, ' qty > 1 -- big ones ', 'id desc');
    expect(sql).toBe(
      'SELECT * FROM shop."Order Items"\nWHERE (qty > 1 -- big ones\n)\nORDER BY id desc',
    );
    expect(browseProblem(sql)).toBeNull();
  });

  it('refuses text that ends the statement or adds another one', () => {
    expect(browseProblem(browseSql(orders, '1 = 1); delete from shop.x; select (1', ''))).toMatch(
      /cannot end the statement/,
    );
    expect(browseProblem(browseSql(orders, '', 'id; drop table x'))).toMatch(
      /cannot end the statement/,
    );
  });
});

/** Rows for every browse statement; the request is recorded. */
function answerBrowse() {
  return vi.spyOn(backend, 'queryExecute').mockImplementation(async (_req, onEvent) => {
    queueMicrotask(() => {
      onEvent({ event: 'statementStarted', index: 0, offset: 0 });
      onEvent({
        event: 'statementDone',
        index: 0,
        offset: 0,
        elapsedMs: 1,
        outcome: {
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
          edit: {
            status: 'editable',
            target: {
              schema: 'shop',
              table: 'customers',
              columns: [
                { name: 'id', typeName: 'int4' },
                { name: 'email', typeName: 'text' },
              ],
              key: [0],
            },
          },
        },
      });
      onEvent({ event: 'finished', status: 'completed', executed: 1, elapsedMs: 1 });
    });
    return 'job-1';
  });
}

async function openCustomers(draft: Partial<ConnectionDraft> = {}) {
  const execute = answerBrowse();
  const { p, user, tree } = await setup(['customers', 'orders'], draft);
  await user.click(screen.getByRole('treeitem', { name: /^Dev/ }));
  tree.focus();
  await user.keyboard('{ArrowRight}');
  await screen.findByRole('treeitem', { name: 'shop, schema' });
  await user.keyboard('{ArrowDown}{ArrowRight}');
  await screen.findByRole('treeitem', { name: 'Tables, folder, 2' });
  await user.keyboard('{ArrowDown}{ArrowRight}{ArrowDown}');
  await waitFor(() =>
    expect(screen.getByRole('treeitem', { name: 'customers, table' })).toHaveAttribute(
      'aria-selected',
      'true',
    ),
  );
  const open = async () => {
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const m = await screen.findByRole('menu');
    await user.click(within(m).getByRole('menuitem', { name: 'Open data' }));
  };
  await open();
  return { p, user, execute, open };
}

/**
 * Types into a field without clicking it first: in jsdom every element sits at 0,0, so the
 * panel resize handle (which hit-tests the pointer) would take the click and the focus.
 */
async function typeInto(
  user: Awaited<ReturnType<typeof openCustomers>>['user'],
  label: string,
  text: string,
) {
  screen.getByLabelText(label).focus();
  await user.keyboard(text);
}

const sent = (execute: { mock: { calls: [ExecRequest, ...unknown[]][] } }) =>
  execute.mock.calls.map(([req]) => req.statements.map((s) => s.sql).join(';'));

describe('Open data', () => {
  it('opens a table in an editable grid in the shared session', async () => {
    const { p, execute, open } = await openCustomers();
    expect(await screen.findByRole('tab', { name: 'customers (data)' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const grid = await screen.findByRole('grid', { name: 'Result rows' });
    expect(within(grid).getByText('b@x.test')).toBeInTheDocument();
    expect(execute.mock.calls[0]?.[0].session).toEqual({ sourceId: p.id });
    expect(sent(execute)).toEqual(['SELECT * FROM shop.customers']);
    // Editable through the M4.2 path.
    expect(screen.getByRole('toolbar', { name: 'Edit rows' })).toHaveTextContent('shop.customers');
    // Opening it again activates the same tab.
    await open();
    expect(screen.getAllByRole('tab', { name: 'customers (data)' })).toHaveLength(1);
  });

  it('applies WHERE and ORDER BY text, remembers it and clears it', async () => {
    const { user, execute } = await openCustomers();
    await screen.findByRole('grid', { name: 'Result rows' });
    await typeInto(user, 'WHERE', 'id > 1');
    await typeInto(user, 'ORDER BY', 'email desc{Enter}');
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(sent(execute)[1]).toBe(
      'SELECT * FROM shop.customers\nWHERE (id > 1\n)\nORDER BY email desc',
    );
    const ws = useWorkspace.getState();
    const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
    expect(tab).toMatchObject({ where: 'id > 1', orderBy: 'email desc' });
    // Saved with the workspace, so a restart reopens the tab with its filter.
    expect(snapshot(useWorkspace.getState()).tabs).toContainEqual(
      expect.objectContaining({ kind: 'data', where: 'id > 1', orderBy: 'email desc' }),
    );
    const history = document.getElementById(
      `${screen.getByLabelText('WHERE').getAttribute('list')}`,
    );
    expect(history?.querySelector('option')?.getAttribute('value')).toBe('id > 1');

    await user.click(screen.getByRole('button', { name: /^Clear$/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(sent(execute)[2]).toBe('SELECT * FROM shop.customers');
    expect(screen.getByLabelText('WHERE')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Clear history' }));
    expect(history?.querySelector('option')).toBeNull();
  });

  it('refuses filter text that would add a statement', async () => {
    const { user, execute } = await openCustomers();
    await screen.findByRole('grid', { name: 'Result rows' });
    await typeInto(user, 'WHERE', '1 = 1); delete from shop.orders; select (1{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot end the statement/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('is read-only on a read-only data source', async () => {
    const { execute } = await openCustomers({ readOnly: true });
    await screen.findByRole('grid', { name: 'Result rows' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('toolbar', { name: 'Edit rows' })).not.toBeInTheDocument();
    expect(screen.getByText(/Read-only: the data source "Dev" is read-only/)).toBeInTheDocument();
  });
});
