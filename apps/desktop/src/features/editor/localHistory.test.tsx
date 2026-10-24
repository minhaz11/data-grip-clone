import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { useNav } from '../../app/navStore';
import { useSettings } from '../../app/settingsStore';
import { isConsole, resetHydrationForTests, useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import { DEFAULT_SETTINGS } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { NEW_DRAFT } from '../connections/model';

beforeEach(async () => {
  for (const name of await backend.consoleList()) {
    await backend.consoleDelete(name);
  }
  await backend.workspaceSet({
    layout: {},
    panels: { explorerCollapsed: false, bottomCollapsed: false },
    tabs: [],
    activeTabId: null,
  });
  resetHydrationForTests();
  useWorkspace.setState({ tabs: [], activeTabId: null, closed: [], hydrated: false });
  useNav.setState({ back: [], forward: [], recent: [] });
  useConnections.setState({ items: [], folders: [], sshProfiles: [], selectedId: null });
  vi.spyOn(backend, 'onConnectionStatus').mockResolvedValue(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function consoleWith(text: string) {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('toolbar', { name: 'Main toolbar' });
  await act(async () => void (await useWorkspace.getState().newConsole(null)));
  await screen.findByRole('textbox', { name: /SQL$/ });
  const id = useWorkspace.getState().activeTabId ?? '';
  await act(async () => {
    useWorkspace.getState().updateText(id, text);
    await useWorkspace.getState().flushAll();
  });
  return { user, id };
}

const tabText = (id: string) => {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === id);
  return isConsole(tab) ? tab.text : undefined;
};

describe('local history', () => {
  it('lists versions with a diff and restores one, keeping the replaced text', async () => {
    const { user, id } = await consoleWith('select * from orders');
    await act(async () => void (await backend.consoleCheckpoint('console', 'beforeRun')));
    await act(async () => {
      useWorkspace.getState().updateText(id, '');
      await useWorkspace.getState().flushAll();
    });

    await user.keyboard('{Alt>}{Shift>}h{/Shift}{/Alt}');
    const dialog = await screen.findByRole('dialog', { name: 'Local History: console.sql' });
    const versions = await within(dialog).findByRole('listbox', { name: 'Versions' });
    expect(within(versions).getByRole('option', { selected: true })).toHaveTextContent(
      /Before run.*select \* from orders/,
    );
    const changes = within(dialog).getByRole('region', { name: /Changes from this version/ });
    expect(await within(changes).findByText('select * from orders')).toBeVisible();
    expect(within(changes).getByLabelText('removed')).toBeInTheDocument();

    const restore = vi.spyOn(backend, 'revisionRestore');
    await user.click(within(dialog).getByRole('button', { name: 'Restore This Version' }));
    await waitFor(() => expect(tabText(id)).toBe('select * from orders'));
    expect(restore).toHaveBeenCalled();
    // The restored text is what the file holds; the tab is not marked unsaved.
    expect(useWorkspace.getState().tabs[0]).toMatchObject({ save: 'saved' });
    expect(await backend.consoleRead('console')).toBe('select * from orders');
  });

  it('keeps the text before a run and before a format', async () => {
    const checkpoint = vi.spyOn(backend, 'consoleCheckpoint');
    vi.spyOn(backend, 'queryExecute').mockResolvedValue('job-1');
    const p = await backend.connectionCreate({ ...NEW_DRAFT, name: 'Dev' }, null);
    const { user, id } = await consoleWith('select 1');
    act(() => useWorkspace.getState().setSource(id, p.id));
    vi.spyOn(backend, 'connectionConnect').mockResolvedValue({
      version: 'x',
      serverVersion: '16',
      database: 'd',
      user: 'u',
      tls: false,
      readOnly: false,
      latencyMs: 1,
    });
    const editor = screen.getByRole('textbox', { name: /SQL$/ });
    editor.focus();
    await user.keyboard('{Control>}{Alt>}l{/Alt}{/Control}');
    await waitFor(() => expect(checkpoint).toHaveBeenCalledWith('console', 'beforeFormat'));
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(checkpoint).toHaveBeenCalledWith('console', 'beforeRun'));
  });

  it('retention is set in Settings', async () => {
    const set = vi.spyOn(backend, 'settingsSet');
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('toolbar', { name: 'Main toolbar' });
    await user.keyboard('{Control>}{Alt>}s{/Alt}{/Control}');
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const limit = within(dialog).getByLabelText(/Local history per console/);
    await user.clear(limit);
    await user.type(limit, '20');
    await user.click(within(dialog).getByRole('button', { name: /Save|Apply/ }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ revisionLimit: 20, revisionMaxAgeDays: 30 }),
      ),
    );
  });
});
