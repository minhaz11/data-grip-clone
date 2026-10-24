import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { ObjectDetails } from '../../ipc/types';
import { useSessions } from '../connections/sessionsStore';
import { registerExplorerHarness, setup } from '../explorer/explorerTestKit';

registerExplorerHarness();

const ORDERS: ObjectDetails = {
  object: { schema: 'shop', name: 'customers', objectType: 'table' },
  comment: 'People who buy',
  columns: [
    {
      name: 'id',
      typeName: 'integer',
      nullable: false,
      default: null,
      primaryKey: true,
      identity: 'always',
      generated: null,
      comment: null,
    },
    {
      name: 'email',
      typeName: 'text',
      nullable: true,
      default: "'n/a'::text",
      primaryKey: false,
      identity: null,
      generated: null,
      comment: 'Login name',
    },
    {
      name: 'doubled',
      typeName: 'integer',
      nullable: true,
      default: null,
      primaryKey: false,
      identity: null,
      generated: '(qty * 2)',
      comment: null,
    },
  ],
  indexes: [{ name: 'customers_pkey', definition: 'btree (id)', unique: true, primary: true }],
  constraints: [{ name: 'customers_pkey', kind: 'primary key', definition: 'PRIMARY KEY (id)' }],
  references: [
    {
      name: 'customers_region_fkey',
      fromSchema: 'shop',
      fromTable: 'customers',
      fromColumns: ['region_id'],
      toSchema: 'geo',
      toTable: 'regions',
      toColumns: ['id'],
      onUpdate: 'NO ACTION',
      onDelete: 'CASCADE',
      deferrable: true,
    },
  ],
  referencedBy: [
    {
      name: 'orders_customer_id_fkey',
      fromSchema: 'shop',
      fromTable: 'orders',
      fromColumns: ['customer_id'],
      toSchema: 'shop',
      toTable: 'customers',
      toColumns: ['id'],
      onUpdate: 'NO ACTION',
      onDelete: 'RESTRICT',
      deferrable: false,
    },
  ],
  triggers: [
    {
      name: 'customers_touch',
      definition: 'BEFORE UPDATE ON shop.customers FOR EACH ROW EXECUTE FUNCTION touch()',
      enabled: false,
    },
  ],
  rowEstimate: 1200,
  totalBytes: 81920,
};

/** Connects, expands down to the Tables level, and returns the tree. */
async function openTables() {
  const { p, user, tree } = await setup();
  await user.click(screen.getByRole('treeitem', { name: /^Dev/ }));
  tree.focus();
  await user.keyboard('{ArrowRight}');
  await screen.findByRole('treeitem', { name: 'shop, schema' });
  await user.keyboard('{ArrowDown}{ArrowRight}');
  await screen.findByRole('treeitem', { name: 'Tables, folder, 2' });
  await user.keyboard('{ArrowDown}{ArrowRight}');
  await screen.findByRole('treeitem', { name: 'customers, table' });
  return { p, user, tree };
}

describe('table viewer and quick info', () => {
  it('opens a table viewer from the explorer and shows every section', async () => {
    const details = vi.spyOn(backend, 'objectDetails').mockResolvedValue(ORDERS);
    const { p, user } = await openTables();
    await user.keyboard('{ArrowDown}{Enter}'); // customers

    const tab = await screen.findByRole('tab', { name: 'customers' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(details).toHaveBeenCalledWith(p.id, {
      schema: 'shop',
      name: 'customers',
      objectType: 'table',
    });
    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByRole('heading', { name: 'shop.customers' })).toBeVisible();
    expect(panel).toHaveTextContent('about 1,200 rows · 80 kB');
    expect(panel).toHaveTextContent('People who buy');

    const columns = within(panel).getByRole('region', { name: 'Columns' });
    const rows = within(columns).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('idintegernot nullGENERATED ALWAYS AS IDENTITY');
    expect(within(rows[1] as HTMLElement).getByLabelText('primary key')).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent("emailtextnull'n/a'::textLogin name");
    expect(rows[3]).toHaveTextContent('GENERATED ALWAYS AS (qty * 2) STORED');
    expect(within(panel).getByRole('region', { name: 'Foreign keys' })).toHaveTextContent(
      'customers_region_fkeyregion_idgeo.regions (id) deferrableNO ACTIONCASCADE',
    );
    expect(within(panel).getByRole('region', { name: 'Referenced by' })).toHaveTextContent(
      'orders_customer_id_fkeyshop.orders (customer_id)idRESTRICT',
    );
    expect(within(panel).getByRole('region', { name: 'Triggers' })).toHaveTextContent('disabled');
    expect(within(panel).getByRole('region', { name: 'Indexes' })).toHaveTextContent('btree (id)');

    // Opening it again activates the same tab.
    await act(async () => {
      useWorkspace.getState().activate(useWorkspace.getState().tabs[0]?.id ?? '');
    });
    screen.getByRole('tree', { name: 'Data sources' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getAllByRole('tab', { name: 'customers' })).toHaveLength(1);
  });

  it('asks to connect when the data source is not connected, and reports a missing object', async () => {
    const details = vi.spyOn(backend, 'objectDetails').mockResolvedValue(null);
    const { p, user } = await setup();
    await act(async () => {
      useWorkspace
        .getState()
        .openObject(p.id, { schema: 'shop', name: 'gone', objectType: 'table' });
    });
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('Connect to Dev to see the structure.');
    expect(details).not.toHaveBeenCalled();

    await user.click(within(panel).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(useSessions.getState().byId[p.id]?.state).toBe('connected'));
    expect(await within(panel).findByText(/This table no longer exists/)).toBeInTheDocument();
  });

  it('shows quick info for a column with Ctrl+Q', async () => {
    vi.spyOn(backend, 'objectDetails').mockResolvedValue(ORDERS);
    const { user } = await openTables();
    await user.keyboard('{ArrowDown}{ArrowRight}'); // customers: expand
    await screen.findByRole('treeitem', { name: 'Columns, folder, 2' });
    await user.keyboard('{ArrowDown}{ArrowRight}{ArrowDown}{ArrowDown}'); // Columns -> email
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: /^email, column/ })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    await user.keyboard('{Control>}q{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'customers.email' });
    expect(await within(dialog).findByText('Login name')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Tableshop.customers');
    expect(dialog).toHaveTextContent('Typetext');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
