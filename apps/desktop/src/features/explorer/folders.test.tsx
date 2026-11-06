import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backend } from '../../ipc/client';
import type { MetadataRequest } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { NEW_DRAFT } from '../connections/model';
import { useSessions } from '../connections/sessionsStore';
import { catalogRelations } from '../editor/catalog';
import { catalog, INFO, registerExplorerHarness, setup } from './explorerTestKit';
import { useMetadata } from './metadataStore';
import { DRAG_TYPE } from './TreeRow';

registerExplorerHarness();

beforeEach(async () => {
  for (const f of await backend.foldersList()) {
    await backend.folderDelete(f.id);
  }
  useConnections.setState({ folders: [], sshProfiles: [] });
  useMetadata.setState({ schemaTotals: {} });
});

const names = () =>
  screen.getAllByRole('treeitem').map((li) => li.getAttribute('aria-label')?.split(',')[0]);

/** Drags a row onto another with the HTML5 drag events the tree listens to. */
function drag(from: HTMLElement, to: HTMLElement) {
  const data = new Map<string, string>();
  const dataTransfer = {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    dropEffect: 'none',
    effectAllowed: 'all',
  };
  for (const [target, make] of [
    [from, createEvent.dragStart],
    [to, createEvent.dragOver],
    [to, createEvent.drop],
  ] as const) {
    const event = make(target);
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    fireEvent(target, event);
  }
}

describe('explorer folders and order', () => {
  it('creates a folder, names it inline, and moves a data source into it', async () => {
    const { user } = await setup();
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    const input = await screen.findByRole('textbox', { name: 'New name' });
    expect(input).toHaveFocus();
    await user.keyboard('{Control>}a{/Control}Production{Enter}');
    const folder = await screen.findByRole('treeitem', { name: /^Production, folder, 0/ });

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('treeitem', { name: /^Dev/ }),
    });
    await user.click(screen.getByRole('menuitem', { name: 'Move to folder…' }));
    const dialog = screen.getByRole('dialog', { name: 'Move Dev' });
    await user.selectOptions(within(dialog).getByLabelText('Folder'), 'Production');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));

    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: /^Production, folder, 1/ })).toBeVisible(),
    );
    const dev = screen.getByRole('treeitem', { name: /^Dev/ });
    expect(dev).toHaveAttribute('aria-level', '2');
    expect(folder).toHaveAttribute('aria-expanded', 'true');
  });

  it('data sources inherit the folder color unless they have their own', async () => {
    await backend.connectionCreate({ ...NEW_DRAFT, name: 'Plain', environment: 'none' }, null);
    const { user } = await setup();
    const folder = await backend.folderCreate('Red', '#aa0000');
    const plain = (await backend.connectionsList()).find((c) => c.name === 'Plain');
    await backend.connectionMove(plain?.id ?? '', folder.id, 0);
    await useConnections.getState().load();
    const row = await screen.findByRole('treeitem', { name: /^Plain/ });
    expect(row).toHaveStyle({ borderLeftColor: '#aa0000' });
    // The folder's own dialog changes it for its members.
    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('treeitem', { name: /^Red, folder/ }),
    });
    await user.click(screen.getByRole('menuitem', { name: 'Properties…' }));
    const dialog = screen.getByRole('dialog', { name: 'Folder: Red' });
    await user.click(within(dialog).getByRole('button', { name: 'No color' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByRole('treeitem', { name: /^Plain/ }).style.borderLeftColor).toBe(
        'transparent',
      ),
    );
  });

  it('renames a data source inline with F2; Escape cancels', async () => {
    const { user, tree } = await setup();
    const rename = vi.spyOn(backend, 'connectionRename');
    tree.focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{F2}');
    await user.keyboard('{Escape}');
    expect(rename).not.toHaveBeenCalled();
    await user.keyboard('{F2}');
    await user.keyboard('{Control>}a{/Control}Development{Enter}');
    await waitFor(() => expect(rename).toHaveBeenCalledWith(expect.any(String), 'Development'));
    expect(await screen.findByRole('treeitem', { name: /^Development/ })).toBeVisible();
    expect(tree).toHaveFocus();
  });

  it('reorders with the keyboard and by dragging', async () => {
    await backend.connectionCreate({ ...NEW_DRAFT, name: 'Alpha' }, null);
    await backend.connectionCreate({ ...NEW_DRAFT, name: 'Beta' }, null);
    const { user, tree } = await setup();
    await waitFor(() => expect(names()).toEqual(['Alpha', 'Beta', 'Dev']));

    tree.focus();
    await user.keyboard('{End}{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}');
    await waitFor(() => expect(names()).toEqual(['Alpha', 'Dev', 'Beta']));

    drag(
      screen.getByRole('treeitem', { name: /^Beta/ }),
      screen.getByRole('treeitem', { name: /^Alpha/ }),
    );
    await waitFor(() => expect(names()).toEqual(['Beta', 'Alpha', 'Dev']));

    // Onto a folder: in it, last.
    const folder = await backend.folderCreate('Group', null);
    await useConnections.getState().load();
    drag(
      screen.getByRole('treeitem', { name: /^Dev/ }),
      await screen.findByRole('treeitem', { name: /^Group, folder/ }),
    );
    await waitFor(() => expect(names()).toEqual(['Group', 'Dev', 'Beta', 'Alpha']));
    expect((await backend.connectionsList()).find((c) => c.name === 'Dev')?.folderId).toBe(
      folder.id,
    );
    expect(DRAG_TYPE).toMatch(/quarry/);
  });

  it('deleting a folder keeps its data sources', async () => {
    const { user } = await setup();
    const folder = await backend.folderCreate('Temp', null);
    const dev = (await backend.connectionsList())[0];
    await backend.connectionMove(dev?.id ?? '', folder.id, 0);
    await useConnections.getState().load();
    await user.pointer({
      keys: '[MouseRight]',
      target: await screen.findByRole('treeitem', { name: /^Temp, folder/ }),
    });
    await user.click(screen.getByRole('menuitem', { name: 'Delete folder…' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Delete Folder' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => expect(names()).toEqual(['Dev']));
    expect(screen.getByRole('treeitem', { name: /^Dev/ })).toHaveAttribute('aria-level', '1');
  });
});

describe('schema scope', () => {
  it('labels a connected source "N of M schemas" and reloads after the scope changes', async () => {
    const base = catalog(['customers']);
    const requests: MetadataRequest['level'][] = [];
    const { p, user, meta } = await setup(['customers'], { schemaNames: ['shop'] });
    meta.mockImplementation(async (id, r) => {
      requests.push(r.level);
      if (r.level === 'allSchemas') {
        return ['public', 'shop', 'audit'].map((name) => ({
          key: `s:${name}`,
          kind: 'schema' as const,
          name,
        }));
      }
      return base(id, r);
    });
    useSessions.setState({ byId: { [p.id]: { state: 'connected', info: INFO } } });

    expect(await screen.findByRole('treeitem', { name: /Dev, .*1 of 3 schemas/ })).toBeVisible();
    expect(requests).toContain('schemas');
    // Completion's catalog is cached per data source...
    await catalogRelations(p.id);

    // Edit the scope: the tree is read again (the backend applies the new scope at once).
    await user.dblClick(screen.getByRole('treeitem', { name: /^Dev/ }));
    const dialog = screen.getByRole('dialog', { name: 'Data Source: Dev' });
    await user.click(within(dialog).getByRole('tab', { name: 'Schemas' }));
    await user.type(within(dialog).getByLabelText('Pattern'), 'aud*');
    const update = vi.spyOn(backend, 'connectionUpdate');
    requests.length = 0;
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        p.id,
        expect.objectContaining({ schemaNames: ['shop'], schemaPattern: 'aud*' }),
        { action: 'keep' },
      ),
    );
    await waitFor(() => expect(requests).toContain('schemas'));
    // ...and read again after the scope changed.
    expect(requests).not.toContain('relations');
    await catalogRelations(p.id);
    expect(requests).toContain('relations');
  });
});
