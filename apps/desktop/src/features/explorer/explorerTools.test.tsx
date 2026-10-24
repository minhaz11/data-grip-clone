import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { MetaNode } from '../../ipc/types';
import { useSessions } from '../connections/sessionsStore';
import { catalog, INFO, registerExplorerHarness, setup } from './explorerTestKit';
import { useMetadata } from './metadataStore';

registerExplorerHarness();

beforeEach(() => {
  useWorkspace.setState({ tabs: [], activeTabId: null });
  useMetadata.setState({ refreshedAt: {}, reveal: null });
});

const visible = () =>
  screen.getAllByRole('treeitem').map((li) => li.getAttribute('aria-label')?.split(',')[0]);

/** Expands Dev > shop > Tables with the keyboard. */
async function openTables(user: Awaited<ReturnType<typeof setup>>['user'], tree: HTMLElement) {
  tree.focus();
  await user.keyboard('{ArrowDown}{ArrowRight}');
  await screen.findByRole('treeitem', { name: 'shop, schema' });
  await user.keyboard('{ArrowDown}{ArrowRight}');
  await screen.findByRole('treeitem', { name: /^Tables, folder/ });
  await user.keyboard('{ArrowDown}{ArrowRight}');
  await screen.findByRole('treeitem', { name: 'customers, table' });
}

describe('explorer tools', () => {
  it('hides object kinds with the type filter', async () => {
    const { user, tree } = await setup();
    await openTables(user, tree);
    expect(visible()).toContain('Routines');
    await user.click(screen.getByRole('button', { name: 'Filter object types' }));
    const group = screen.getByRole('group', { name: 'Object types to show' });
    await user.click(within(group).getByLabelText('Tables'));
    expect(visible()).not.toContain('customers');
    expect(visible()).not.toContain('Tables');
    expect(visible()).toContain('Routines');
    expect(screen.getByRole('button', { name: /Filter object types \(1 hidden\)/ })).toBeVisible();
    await user.click(within(group).getByRole('button', { name: 'Show all' }));
    expect(visible()).toContain('customers');
  });

  it('collapses everything and expands loaded levels again', async () => {
    const { user, tree } = await setup();
    await openTables(user, tree);
    await user.keyboard('{Control>}-{/Control}');
    expect(visible()).toEqual(['Dev']);
    // Expand all below the data source: every loaded level opens again.
    screen.getByRole('treeitem', { name: /^Dev/ }).click();
    tree.focus();
    await user.keyboard('{Control>}={/Control}');
    expect(visible()).toEqual(expect.arrayContaining(['shop', 'Tables', 'customers', 'orders']));
  });

  it('marks several objects and shows their DDL together', async () => {
    const { user, tree } = await setup();
    await openTables(user, tree);
    await user.click(screen.getByRole('treeitem', { name: 'customers, table' }));
    tree.focus();
    await user.keyboard('{Shift>}{ArrowDown}{/Shift}');
    const marked = screen
      .getAllByRole('treeitem')
      .filter((li) => li.getAttribute('aria-selected') === 'true')
      .map((li) => li.getAttribute('aria-label'));
    expect(marked).toEqual(['customers, table', 'orders, table']);

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('treeitem', { name: 'orders, table' }),
    });
    expect(screen.getByRole('menuitem', { name: /Copy 2 names/ })).toBeVisible();
    await user.keyboard('{Escape}');
    tree.focus();
    await user.keyboard('{Control>}b{/Control}');
    expect(useWorkspace.getState().tabs[0]).toMatchObject({
      kind: 'ddl',
      title: '2 objects',
      objects: [
        { kind: 'relation', schema: 'shop', name: 'customers' },
        { kind: 'relation', schema: 'shop', name: 'orders' },
      ],
    });

    // Ctrl+click toggles one row in or out.
    await user.click(screen.getByRole('treeitem', { name: 'customers, table' }));
    await user.keyboard('{Control>}');
    await user.click(screen.getByRole('treeitem', { name: 'orders, table' }));
    await user.click(screen.getByRole('treeitem', { name: 'customers, table' }));
    await user.keyboard('{/Control}');
    expect(screen.getByRole('treeitem', { name: 'customers, table' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('jumps to the next and previous match from the filter', async () => {
    const { user, tree } = await setup(['orders', 'order_items', 'customers']);
    await openTables(user, tree);
    const filter = screen.getByRole('searchbox', { name: 'Filter loaded objects' });
    // Focus directly: in jsdom's zero-size layout a click lands on the panel splitter.
    filter.focus();
    await user.keyboard('order');
    const selected = () =>
      screen
        .getAllByRole('treeitem')
        .find((li) => li.getAttribute('aria-selected') === 'true')
        ?.getAttribute('aria-label');
    await user.keyboard('{Enter}');
    expect(selected()).toBe('orders, table');
    await user.keyboard('{Enter}');
    expect(selected()).toBe('order_items, table');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(selected()).toBe('orders, table');
    expect(filter).toHaveFocus();
  });

  it('cancels a slow load and offers Retry', async () => {
    const { p, user, tree, meta } = await setup();
    const cancel = vi.spyOn(backend, 'metadataCancel').mockResolvedValue(true);
    const slow = catalog(['customers']);
    let release: (nodes: MetaNode[]) => void = () => {};
    meta.mockImplementation((id, r) =>
      r.level === 'schemas' ? new Promise((resolve) => (release = resolve)) : slow(id, r),
    );
    tree.focus();
    await user.keyboard('{ArrowDown}{ArrowRight}');
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalledWith(p.id);
    expect(await screen.findByText('Loading cancelled.')).toBeVisible();
    // A late answer for the cancelled request is ignored.
    act(() => release([]));
    expect(screen.getByText('Loading cancelled.')).toBeVisible();
    meta.mockImplementation(slow);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('treeitem', { name: 'shop, schema' })).toBeVisible();
  });

  it('force refresh reloads loaded levels and shows when it last did', async () => {
    const { p, user, tree, meta } = await setup();
    await openTables(user, tree);
    const before = useMetadata.getState().refreshedAt[p.id] ?? 0;
    expect(before).toBeGreaterThan(0);
    meta.mockClear();
    await user.click(screen.getByRole('treeitem', { name: /^Dev/ }));
    act(() => useSessions.setState({ byId: { [p.id]: { state: 'connected', info: INFO } } }));
    tree.focus();
    await user.keyboard('{Control>}{Shift>}{F5}{/Shift}{/Control}');
    await waitFor(() => expect(meta).toHaveBeenCalledWith(p.id, { level: 'schemas' }));
    await screen.findByRole('treeitem', { name: 'customers, table' });
    expect(screen.getByRole('treeitem', { name: /^Dev/ }).title).toMatch(/Refreshed at /);
  });
});
