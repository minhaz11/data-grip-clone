import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import { registerExplorerHarness, setup } from '../explorer/explorerTestKit';

registerExplorerHarness();

const SCRIPT = 'CREATE TABLE shop.customers (\n    id bigint NOT NULL\n);\n';

/** Connects and expands down to the Tables level. */
async function openTree() {
  const { p, user, tree } = await setup();
  await user.click(screen.getByRole('treeitem', { name: /^Dev/ }));
  tree.focus();
  await user.keyboard('{ArrowRight}');
  await screen.findByRole('treeitem', { name: 'shop, schema' });
  return { p, user, tree };
}

async function menuAction(user: Awaited<ReturnType<typeof openTree>>['user'], label: string) {
  await user.keyboard('{Shift>}{F10}{/Shift}');
  const menu = await screen.findByRole('menu');
  await user.click(within(menu).getByRole('menuitem', { name: new RegExp(`^${label}`) }));
}

describe('DDL generation in the UI', () => {
  it('shows a table DDL read-only, regenerates with options, and opens or copies it', async () => {
    const generate = vi.spyOn(backend, 'ddlGenerate').mockResolvedValue(SCRIPT);
    const { p, user } = await openTree();
    // userEvent.setup() installs a clipboard stub; watch it.
    const write = vi.spyOn(navigator.clipboard, 'writeText');
    await user.keyboard('{ArrowDown}{ArrowRight}');
    await screen.findByRole('treeitem', { name: 'Tables, folder, 2' });
    await user.keyboard('{ArrowDown}{ArrowRight}{ArrowDown}'); // Tables -> customers
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: 'customers, table' })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    await menuAction(user, 'Show DDL');

    expect(await screen.findByRole('tab', { name: 'DDL: shop.customers' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const editor = (await screen.findByRole('textbox', {
      name: 'shop.customers DDL SQL',
    })) as HTMLTextAreaElement;
    expect(editor.value).toBe(SCRIPT);
    expect(editor).toHaveAttribute('readonly');
    expect(generate).toHaveBeenLastCalledWith(
      p.id,
      [{ kind: 'relation', schema: 'shop', name: 'customers' }],
      { qualify: true, owner: false, grants: false },
    );

    const toolbar = screen.getByRole('toolbar', { name: 'DDL toolbar' });
    await user.click(within(toolbar).getByLabelText('Qualified names'));
    await waitFor(() =>
      expect(generate).toHaveBeenLastCalledWith(p.id, expect.any(Array), {
        qualify: false,
        owner: false,
        grants: false,
      }),
    );

    await user.click(await within(toolbar).findByRole('button', { name: 'Copy' }));
    expect(write).toHaveBeenCalledWith(SCRIPT);
    expect(within(toolbar).getByRole('status')).toHaveTextContent('Copied to the clipboard.');

    await user.click(within(toolbar).getByRole('button', { name: 'Open in console' }));
    await waitFor(() => {
      const console = useWorkspace
        .getState()
        .tabs.find((t) => t.kind !== 'ddl' && t.kind !== 'object');
      expect(console && 'text' in console ? console.text : null).toBe(SCRIPT);
    });
  });

  it('generates a whole schema and a routine with its identity arguments', async () => {
    const generate = vi.spyOn(backend, 'ddlGenerate').mockResolvedValue('-- ddl\n');
    const { p, user } = await openTree();
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: /^Dev/ })).toHaveAttribute(
        'aria-expanded',
        'true',
      ),
    );
    await user.keyboard('{ArrowDown}'); // shop
    await menuAction(user, 'Show DDL');
    expect(await screen.findByRole('tab', { name: 'DDL: shop' })).toBeInTheDocument();
    // The opened DDL takes focus once generated; go back to the tree after that.
    await screen.findByRole('textbox', { name: 'shop DDL SQL' });
    expect(generate).toHaveBeenLastCalledWith(p.id, [{ kind: 'schema', schema: 'shop' }], {
      qualify: true,
      owner: false,
      grants: false,
    });

    screen.getByRole('tree', { name: 'Data sources' }).focus();
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('treeitem', { name: /^Routines, folder, 1/ });
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowRight}'); // Tables, Routines: expand
    await screen.findByRole('treeitem', { name: /^price, routine/ });
    await user.keyboard('{ArrowDown}');
    await menuAction(user, 'Show DDL');
    expect(await screen.findByRole('tab', { name: 'DDL: shop.price(qty integer)' })).toBeVisible();
    expect(generate).toHaveBeenLastCalledWith(
      p.id,
      [{ kind: 'routine', schema: 'shop', name: 'price', args: 'qty integer' }],
      expect.any(Object),
    );
  });
});
