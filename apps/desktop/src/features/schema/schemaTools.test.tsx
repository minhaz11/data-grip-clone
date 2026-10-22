import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { ConnectionDraft, SchemaChange, TableModel } from '../../ipc/types';
import { registerExplorerHarness, setup } from '../explorer/explorerTestKit';
import { useMetadata } from '../explorer/metadataStore';

registerExplorerHarness();

/** A stand-in for the Rust builder: one statement naming the change. */
function previewOf(change: SchemaChange): string[] {
  switch (change.kind) {
    case 'createTable':
      return [`CREATE TABLE ${change.table.schema}.${change.table.name} (...)`];
    case 'alterTable':
      return [`ALTER TABLE ${change.original.schema}.${change.original.name} ...`];
    case 'drop':
      return [`DROP ${change.cascade ? 'CASCADE' : 'PLAIN'}`];
    case 'truncate':
      return ['TRUNCATE TABLE x'];
    case 'rename':
      return [`RENAME TO ${change.newName}`];
  }
}

async function connectedTree(draft: Partial<ConnectionDraft> = {}) {
  const preview = vi
    .spyOn(backend, 'schemaPreview')
    .mockImplementation(async (change) => previewOf(change));
  const apply = vi.spyOn(backend, 'schemaApply').mockResolvedValue(null);
  const { p, user, tree } = await setup(['customers', 'orders'], draft);
  await user.click(screen.getByRole('treeitem', { name: /^Dev/ }));
  tree.focus();
  await user.keyboard('{ArrowRight}');
  await screen.findByRole('treeitem', { name: 'shop, schema' });
  return { p, user, tree, preview, apply };
}

async function menu(user: Awaited<ReturnType<typeof connectedTree>>['user'], label: string) {
  await user.keyboard('{Shift>}{F10}{/Shift}');
  const m = await screen.findByRole('menu');
  await user.click(within(m).getByRole('menuitem', { name: new RegExp(`^${label}`) }));
}

async function selectCustomers(user: Awaited<ReturnType<typeof connectedTree>>['user']) {
  await user.keyboard('{ArrowDown}{ArrowRight}');
  await screen.findByRole('treeitem', { name: 'Tables, folder, 2' });
  await user.keyboard('{ArrowDown}{ArrowRight}{ArrowDown}');
  await waitFor(() =>
    expect(screen.getByRole('treeitem', { name: 'customers, table' })).toHaveAttribute(
      'aria-selected',
      'true',
    ),
  );
}

describe('schema change tools', () => {
  it('creates a table from the form after showing its statements', async () => {
    const { p, user, preview, apply } = await connectedTree();
    const schemaKey = `${p.id}\u001fs:shop`;
    await user.keyboard('{ArrowDown}'); // shop
    await menu(user, 'New table');
    const dialog = await screen.findByRole('dialog', { name: 'New table in shop' });
    const create = within(dialog).getByRole('button', { name: 'Create' });

    await user.type(within(dialog).getByLabelText('Name'), 'events');
    await user.click(within(dialog).getByRole('button', { name: 'Add to columns' }));
    await user.type(within(dialog).getByLabelText('Column 2 name'), 'title');
    await user.click(within(dialog).getByLabelText('Column 2 not null'));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Statements to run')).toHaveTextContent(
        'CREATE TABLE shop.events (...);',
      ),
    );
    const last = preview.mock.calls.at(-1)?.[0] as Extract<SchemaChange, { kind: 'createTable' }>;
    expect(last.table.columns.map((c) => [c.name, c.notNull])).toEqual([
      ['id', true],
      ['title', true],
    ]);
    expect(last.table.primaryKey).toEqual({ name: null, columns: ['id'] });

    await user.click(create);
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith(p.id, ['CREATE TABLE shop.events (...)']),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useMetadata.getState().children[schemaKey]).toBeUndefined(); // refreshed
  });

  it('needs the name typed to drop with CASCADE', async () => {
    const { p, user, apply } = await connectedTree();
    await selectCustomers(user);
    await menu(user, 'Drop');
    const dialog = await screen.findByRole('dialog', { name: 'Drop table shop.customers' });
    const drop = within(dialog).getByRole('button', { name: 'Drop' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await waitFor(() => expect(drop).toBeEnabled());

    await user.click(within(dialog).getByLabelText(/CASCADE/));
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Statements to run')).toHaveTextContent('DROP CASCADE'),
    );
    expect(drop).toBeDisabled();
    const typed = within(dialog).getByLabelText(/Type shop\.customers to confirm/);
    await user.type(typed, 'shop.customer');
    expect(drop).toBeDisabled();
    await user.type(typed, 's');
    expect(drop).toBeEnabled();
    await user.click(drop);
    await waitFor(() => expect(apply).toHaveBeenCalledWith(p.id, ['DROP CASCADE']));
  });

  type User = Awaited<ReturnType<typeof connectedTree>>['user'];
  const productionTools: {
    tool: string;
    dialog: string;
    button: string;
    statement: string;
    fill?: (user: User, dialog: HTMLElement) => Promise<void>;
  }[] = [
    {
      tool: 'New table',
      dialog: 'New table in shop',
      button: 'Create',
      statement: 'CREATE TABLE shop.events (...);',
      fill: async (user, dialog) => {
        await user.type(within(dialog).getByLabelText('Name'), 'events');
      },
    },
    {
      tool: 'Modify table',
      dialog: 'Modify shop.customers',
      button: 'Apply',
      statement: 'ALTER TABLE shop.customers ...;',
    },
    {
      tool: 'Drop',
      dialog: 'Drop table shop.customers',
      button: 'Drop',
      statement: 'DROP PLAIN;',
    },
    {
      tool: 'Truncate',
      dialog: 'Truncate shop.customers',
      button: 'Truncate',
      statement: 'TRUNCATE TABLE x;',
    },
    {
      tool: 'Rename',
      dialog: 'Rename customers',
      button: 'Rename',
      statement: 'RENAME TO clients;',
      fill: async (user, dialog) => {
        const name = within(dialog).getByLabelText('New name');
        await user.clear(name);
        await user.type(name, 'clients');
      },
    },
  ];

  it.each(productionTools)(
    'confirms $tool on a production data source with its statements',
    async ({ tool, dialog: title, button, statement, fill }) => {
      vi.spyOn(backend, 'tableModel').mockResolvedValue({
        schema: 'shop',
        name: 'customers',
        comment: null,
        columns: [],
        primaryKey: null,
        uniques: [],
        checks: [],
        foreignKeys: [],
        indexes: [],
      });
      const { user, apply } = await connectedTree({ environment: 'production' });
      if (tool === 'New table') {
        await user.keyboard('{ArrowDown}'); // shop
      } else {
        await selectCustomers(user);
      }
      await menu(user, tool);
      const dialog = await screen.findByRole('dialog', { name: title });
      await fill?.(user, dialog);
      const submit = within(dialog).getByRole('button', { name: button });
      await waitFor(() => expect(submit).toBeEnabled());
      await user.click(submit);
      const confirm = await screen.findByRole('dialog', { name: 'Change production: Dev?' });
      expect(confirm).toHaveTextContent(statement);
      expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();
      await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
      expect(apply).not.toHaveBeenCalled();
    },
  );

  it('runs hand-edited SQL through the destructive check', async () => {
    const { p, user, apply } = await connectedTree();
    await selectCustomers(user);
    await menu(user, 'Rename');
    const dialog = await screen.findByRole('dialog', { name: 'Rename customers' });
    const name = within(dialog).getByLabelText('New name');
    await user.clear(name);
    await user.type(name, 'clients');
    await waitFor(() =>
      expect(within(dialog).getByLabelText('Statements to run')).toHaveTextContent(
        'RENAME TO clients;',
      ),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Edit SQL' }));
    const sql = within(dialog).getByLabelText('Statements to run');
    await user.type(sql, '\ndelete from shop.orders;');
    expect(within(dialog).getByText(/Edited by hand/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    const confirm = await screen.findByRole('dialog', { name: 'Run destructive statements?' });
    await user.click(within(confirm).getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(apply).toHaveBeenCalledWith(p.id, ['RENAME TO clients', 'delete from shop.orders']),
    );
  });

  it('modifies a table starting from its catalog model', async () => {
    const model: TableModel = {
      schema: 'shop',
      name: 'customers',
      comment: null,
      columns: [
        {
          name: 'id',
          original: 'id',
          typeName: 'bigint',
          notNull: true,
          default: null,
          identity: 'always',
          comment: null,
        },
      ],
      primaryKey: { name: 'customers_pkey', columns: ['id'] },
      uniques: [],
      checks: [],
      foreignKeys: [],
      indexes: [],
    };
    vi.spyOn(backend, 'tableModel').mockResolvedValue(model);
    const { user, preview } = await connectedTree();
    await selectCustomers(user);
    await menu(user, 'Modify table');
    const dialog = await screen.findByRole('dialog', { name: 'Modify shop.customers' });
    const name = await within(dialog).findByLabelText('Column 1 name');
    await user.clear(name);
    await user.type(name, 'customer_id');
    await waitFor(() => {
      const change = preview.mock.calls.at(-1)?.[0] as Extract<
        SchemaChange,
        { kind: 'alterTable' }
      >;
      expect(change.kind).toBe('alterTable');
      expect(change.original).toEqual(model);
      expect(change.table.columns[0]).toMatchObject({ name: 'customer_id', original: 'id' });
      // The primary key follows the renamed column.
      expect(change.table.primaryKey).toEqual({ name: 'customers_pkey', columns: ['customer_id'] });
    });
  });

  it('offers no schema tools on read-only sources', async () => {
    const { user } = await connectedTree({ readOnly: true });
    await selectCustomers(user);
    await user.keyboard('{Shift>}{F10}{/Shift}');
    const m = await screen.findByRole('menu');
    expect(within(m).queryByRole('menuitem', { name: /Drop|Truncate|Rename|Modify/ })).toBeNull();
  });

  it('marks the tree out of date after DDL runs in a console', async () => {
    vi.spyOn(backend, 'queryExecute').mockImplementation(async (_req, onEvent) => {
      queueMicrotask(() => {
        onEvent({ event: 'statementStarted', index: 0, offset: 0 });
        onEvent({
          event: 'statementDone',
          index: 0,
          offset: 0,
          elapsedMs: 1,
          outcome: { type: 'command', rowsAffected: 0 },
        });
        onEvent({ event: 'finished', status: 'completed', executed: 1, elapsedMs: 1 });
      });
      return 'job-1';
    });
    const { p, user } = await connectedTree();
    await act(async () => {
      await useWorkspace.getState().newConsole(p.id);
    });
    const editor = (await screen.findByRole('textbox', { name: /SQL$/ })) as HTMLTextAreaElement;
    editor.focus();
    await user.keyboard('create table shop.audit (id int){Control>}{Enter}{/Control}');
    const banner = await screen.findByText(/Dev may be out of date/);
    await user.click(
      within(banner.parentElement as HTMLElement).getByRole('button', { name: 'Refresh' }),
    );
    expect(screen.queryByText(/Dev may be out of date/)).not.toBeInTheDocument();
  });
});
