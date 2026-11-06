import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { useNav } from '../../app/navStore';
import { isConsole, resetHydrationForTests, useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { ServerInfo } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { NEW_DRAFT } from '../connections/model';
import { useSessions } from '../connections/sessionsStore';
import { useExec } from '../exec/execStore';

const INFO: ServerInfo = {
  version: 'PostgreSQL 16.15',
  serverVersion: '16.15',
  database: 'app',
  user: 'dev',
  tls: false,
  readOnly: false,
  latencyMs: 2,
};

beforeEach(async () => {
  for (const c of await backend.connectionsList()) {
    await backend.connectionDelete(c.id);
  }
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
  useSessions.setState({ byId: {} });
  useExec.setState({ runs: {}, view: {} });
  vi.spyOn(backend, 'onConnectionStatus').mockResolvedValue(() => {});
  vi.spyOn(backend, 'connectionConnect').mockResolvedValue(INFO);
});
afterEach(() => vi.restoreAllMocks());

async function renderApp() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('toolbar', { name: 'Main toolbar' });
  return user;
}

async function openConsole(text: string, sourceId: string | null = null) {
  await act(async () => void (await useWorkspace.getState().newConsole(sourceId)));
  const editor = (await screen.findByRole('textbox', { name: /SQL$/ })) as HTMLTextAreaElement;
  if (text) {
    await act(async () => {
      const id = useWorkspace.getState().activeTabId ?? '';
      useWorkspace.getState().updateText(id, text);
      await useWorkspace.getState().flushAll();
    });
  }
  return editor;
}

const editors = () => screen.getByRole('tablist', { name: 'Open editors' });
const tab = (name: RegExp) => within(editors()).getByRole('tab', { name });
const tabNames = () =>
  within(editors())
    .queryAllByRole('tab')
    .map((t) => t.textContent ?? '');

async function tabMenu(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.pointer({ keys: '[MouseRight]', target: tab(name) });
  return screen.getByRole('menu', { name: 'Tab actions' });
}

describe('editor tabs and consoles', () => {
  it('reopens the last closed console with its text', async () => {
    const user = await renderApp();
    await openConsole('select 1');
    await openConsole('select 2');
    expect(tabNames()).toEqual(['console.sql', 'console_1.sql']);

    await user.keyboard('{Control>}w{/Control}');
    await waitFor(() => expect(tabNames()).toEqual(['console.sql']));
    await user.keyboard('{Control>}{Shift>}t{/Shift}{/Control}');
    await waitFor(() => expect(tabNames()).toEqual(['console.sql', 'console_1.sql']));
    const reopened = useWorkspace
      .getState()
      .tabs.find((t) => isConsole(t) && t.console === 'console_1');
    expect(isConsole(reopened) && reopened.text).toBe('select 2');
    expect(tab(/console_1/)).toHaveAttribute('aria-selected', 'true');
  });

  it('renames a console in place: same tab, editor, text and data source', async () => {
    const p = await backend.connectionCreate({ ...NEW_DRAFT, name: 'Dev' }, null);
    const user = await renderApp();
    const editor = await openConsole('select 42', p.id);
    const before = useWorkspace.getState().tabs[0];
    const menu = await tabMenu(user, /console\.sql/);
    await user.click(within(menu).getByRole('menuitem', { name: 'Rename console…' }));
    const dialog = screen.getByRole('dialog', { name: 'Rename Console' });
    const field = within(dialog).getByLabelText('New name');
    await user.clear(field);
    await user.type(field, 'bad/name');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/Use letters/);
    await user.clear(field);
    await user.type(field, 'orders report');
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }));

    await waitFor(() => expect(tabNames()).toEqual(['orders report.sql']));
    const after = useWorkspace.getState().tabs[0];
    expect(after?.id).toBe(before?.id);
    expect(isConsole(after) && [after.text, after.sourceId]).toEqual(['select 42', p.id]);
    // The same editor element: it was not remounted, so its undo history is intact.
    expect(screen.getByRole('textbox', { name: /SQL$/ })).toBe(editor);
    expect(await backend.consoleList()).toContain('orders report');
  });

  it('asks before deleting a console and closes its tab', async () => {
    const user = await renderApp();
    await openConsole('select 1');
    const del = vi.spyOn(backend, 'consoleDelete');
    let menu = await tabMenu(user, /console\.sql/);
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete console…' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Delete Console' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(del).not.toHaveBeenCalled();

    menu = await tabMenu(user, /console\.sql/);
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete console…' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Delete Console' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('tablist', { name: 'Open editors' })).toBeNull());
    expect(del).toHaveBeenCalledWith('console');
    // A deleted console is not offered for reopening.
    expect(useWorkspace.getState().closed).toEqual([]);
  });

  it('Close others keeps pinned tabs, which stay first', async () => {
    const user = await renderApp();
    await openConsole('');
    await openConsole('');
    await openConsole('');
    let menu = await tabMenu(user, /console_2/);
    await user.click(within(menu).getByRole('menuitem', { name: 'Pin tab' }));
    expect(tabNames()[0]).toMatch(/console_2/);
    menu = await tabMenu(user, /^console\.sql/);
    await user.click(within(menu).getByRole('menuitem', { name: 'Close others' }));
    await waitFor(() => expect(tabNames()).toHaveLength(2));
    expect(tabNames()[0]).toMatch(/console_2/);
    expect(tabNames()[1]).toMatch(/^console\.sql/);
  });

  it('moves between tabs with the arrow keys and lists every tab', async () => {
    const user = await renderApp();
    await openConsole('');
    await openConsole('');
    tab(/console_1/).focus();
    await user.keyboard('{ArrowLeft}');
    await waitFor(() => expect(tab(/^console\.sql/)).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'All tabs (2)' }));
    const list = screen.getByRole('menu', { name: 'All tabs' });
    await user.click(within(list).getByRole('menuitem', { name: /console_1/ }));
    expect(tab(/console_1/)).toHaveAttribute('aria-selected', 'true');
  });

  it('goes back and forward across tabs, and lists recent tabs', async () => {
    const user = await renderApp();
    await openConsole('');
    await openConsole('');
    await openConsole('');
    act(() => useWorkspace.getState().activate(useWorkspace.getState().tabs[0]?.id ?? ''));
    const active = () => within(editors()).getByRole('tab', { selected: true }).textContent;
    expect(active()).toMatch(/^console\.sql/);

    await user.keyboard('{Control>}{Alt>}{ArrowLeft}{/Alt}{/Control}');
    await waitFor(() => expect(active()).toMatch(/console_2/));
    await user.keyboard('{Control>}{Alt>}{ArrowRight}{/Alt}{/Control}');
    await waitFor(() => expect(active()).toMatch(/^console\.sql/));

    await user.keyboard('{Control>}e{/Control}');
    const recent = screen.getByRole('listbox', { name: 'Recent tabs' });
    // The previous tab is preselected: Enter switches back.
    expect(within(recent).getByRole('option', { selected: true })).toHaveTextContent('console_2');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(active()).toMatch(/console_2/));
  });

  it('asks which data source a scratch console runs against', async () => {
    const p = await backend.connectionCreate({ ...NEW_DRAFT, name: 'Dev' }, null);
    const execute = vi.spyOn(backend, 'queryExecute').mockResolvedValue('job-1');
    const user = await renderApp();
    const editor = await openConsole('select 1');
    editor.focus();
    await user.keyboard('{Control>}{Enter}{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Attach Data Source' });
    await user.click(within(dialog).getByRole('button', { name: 'Attach and Run' }));
    await waitFor(() => expect(execute).toHaveBeenCalled());
    const tab = useWorkspace.getState().tabs[0];
    expect(isConsole(tab) && tab.sourceId).toBe(p.id);
  });

  it('Escape in a panel returns to the editor; hide all panels toggles both', async () => {
    const user = await renderApp();
    const editor = await openConsole('select 1');
    screen.getByRole('button', { name: 'New folder' }).focus();
    await user.keyboard('{Escape}');
    expect(editor).toHaveFocus();

    await user.keyboard('{Control>}{Shift>}{F12}{/Shift}{/Control}');
    expect(useWorkspace.getState().explorerCollapsed).toBe(true);
    expect(useWorkspace.getState().bottomCollapsed).toBe(true);
    await user.keyboard('{Control>}{Shift>}{F12}{/Shift}{/Control}');
    expect(useWorkspace.getState().explorerCollapsed).toBe(false);
    expect(useWorkspace.getState().bottomCollapsed).toBe(false);
  });

  it('shows the schema and encoding of the active console', async () => {
    const p = await backend.connectionCreate({ ...NEW_DRAFT, name: 'Dev' }, null);
    await renderApp();
    await openConsole('', p.id);
    expect(screen.getByLabelText('Current schema')).toHaveTextContent('Schema: server default');
    act(() => useWorkspace.getState().setSchema(useWorkspace.getState().activeTabId ?? '', 'shop'));
    expect(screen.getByLabelText('Current schema')).toHaveTextContent('Schema: shop');
    expect(screen.getByLabelText('Encoding')).toHaveTextContent('UTF-8');
  });
});
