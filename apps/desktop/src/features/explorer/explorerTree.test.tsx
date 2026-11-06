import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { backend } from '../../ipc/client';
import { catalog, emitStatus, registerExplorerHarness, setup } from './explorerTestKit';
import { useMetadata } from './metadataStore';

registerExplorerHarness();

describe('explorer metadata tree', () => {
  it('connects on expand and walks down to columns with the keyboard', async () => {
    const { p, user, tree, meta } = await setup();
    await user.click(screen.getByRole('treeitem', { name: /^Dev/ }));
    tree.focus();

    await user.keyboard('{ArrowRight}'); // expand data source -> connects, loads schemas
    expect(backend.connectionConnect).toHaveBeenCalledWith(p.id, null, null);
    const shop = await screen.findByRole('treeitem', { name: 'shop, schema' });
    expect(screen.getByRole('treeitem', { name: /^Dev/ })).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{ArrowDown}{ArrowRight}'); // select + expand shop
    expect(shop).toHaveAttribute('aria-selected', 'true');
    const tables = await screen.findByRole('treeitem', { name: 'Tables, folder, 2' });
    await user.keyboard('{ArrowDown}{ArrowRight}{ArrowRight}'); // Tables: expand, then move to first child
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: 'customers, table' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(tables).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{ArrowRight}{ArrowDown}{ArrowRight}'); // customers -> Columns -> expand
    const id = await screen.findByRole('treeitem', {
      name: 'id, column, bigint, not null, primary key',
    });
    expect(id).not.toHaveAttribute('aria-expanded');
    expect(meta).toHaveBeenCalledWith(p.id, {
      level: 'columns',
      schema: 'shop',
      table: 'customers',
    });

    await user.keyboard('{ArrowLeft}'); // collapse Columns
    expect(screen.queryByRole('treeitem', { name: /^id, column/ })).not.toBeInTheDocument();
    await user.keyboard('{ArrowLeft}'); // move to parent "customers"
    expect(screen.getByRole('treeitem', { name: 'customers, table' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('refresh reloads a level and keeps expansion; filter searches loaded nodes', async () => {
    const tables = ['customers', 'orders'];
    const { user, tree, meta } = await setup(tables);
    await user.click(screen.getByRole('treeitem', { name: /^Dev/ }));
    tree.focus();
    await user.keyboard('{ArrowRight}');
    await user.click(await screen.findByRole('treeitem', { name: 'shop, schema' }));
    tree.focus();
    await user.keyboard('{ArrowRight}');
    await user.click(await screen.findByRole('treeitem', { name: /^Tables/ }));
    tree.focus();
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('treeitem', { name: 'orders, table' });

    tables.push('payments');
    meta.mockImplementation(catalog(tables));
    await user.click(screen.getByRole('treeitem', { name: 'shop, schema' }));
    tree.focus();
    await user.keyboard('{Control>}{F5}{/Control}');
    expect(await screen.findByRole('treeitem', { name: 'payments, table' })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: 'Tables, folder, 3' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    // jsdom: the panel library swallows pointer focus (see App.test); focus the box directly.
    screen.getByRole('searchbox', { name: 'Filter loaded objects' }).focus();
    await user.keyboard('pay');
    const items = within(tree)
      .getAllByRole('treeitem')
      .map((li) => li.getAttribute('aria-label')?.split(',')[0]);
    expect(items).toEqual(['Dev', 'shop', 'Tables', 'payments']);
    await user.keyboard('{Escape}');
    expect(within(tree).getAllByRole('treeitem').length).toBeGreaterThan(4);
  });

  it('collapses and forgets a source tree when its session is lost', async () => {
    const { p, user, tree } = await setup();
    await user.click(screen.getByRole('treeitem', { name: /^Dev/ }));
    tree.focus();
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('treeitem', { name: 'shop, schema' });

    act(() => emitStatus({ state: 'lost', id: p.id, reason: 'server closed the connection' }));
    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: 'shop, schema' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('treeitem', { name: /^Dev/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(useMetadata.getState().children[p.id]).toBeUndefined();
  });
});
