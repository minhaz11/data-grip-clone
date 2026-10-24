import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { resetHydrationForTests, useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { MetaNode, MetadataRequest, ServerInfo } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { NEW_DRAFT } from '../connections/model';
import { useSessions } from '../connections/sessionsStore';
import { resetCatalog } from '../editor/catalog';
import { catalog } from '../explorer/explorerTestKit';
import { useMetadata } from '../explorer/metadataStore';

const INFO: ServerInfo = {
  version: 'PostgreSQL 16.15',
  serverVersion: '16.15',
  database: 'app',
  user: 'dev',
  tls: false,
  readOnly: false,
  latencyMs: 2,
};

const obj = (schema: string, key: string, kind: MetaNode['kind'], name: string): MetaNode => ({
  key: `${schema}\u001f${key}`,
  kind,
  name,
  detail: schema,
});

/** The palette's catalog plus the explorer levels, like the backend answers them. */
function backendCatalog(tables: string[]) {
  const tree = catalog(tables);
  return async (id: string, r: MetadataRequest): Promise<MetaNode[]> => {
    if (r.level === 'catalog') {
      return [
        ...tables.map((t) => obj('shop', `o:${t}`, 'table', t)),
        obj('shop', 'o:order_totals', 'view', 'order_totals'),
        obj('shop', 'r:price(qty integer)', 'routine', 'price'),
        obj('audit', 'o:orders', 'table', 'orders'),
      ];
    }
    if (r.level === 'columns') {
      return [
        { key: 'c:id', kind: 'column', name: 'id' },
        { key: 'c:customer_id', kind: 'column', name: 'customer_id' },
      ];
    }
    return tree(id, r);
  };
}

let sourceId = '';

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
  resetCatalog();
  useWorkspace.setState({ tabs: [], activeTabId: null, closed: [], hydrated: false });
  useConnections.setState({ items: [], folders: [], sshProfiles: [], selectedId: null });
  useMetadata.setState({ children: {}, expanded: {}, reveal: null });
  vi.spyOn(backend, 'onConnectionStatus').mockResolvedValue(() => {});
  vi.spyOn(backend, 'connectionConnect').mockResolvedValue(INFO);
  vi.spyOn(backend, 'metadataChildren').mockImplementation(
    backendCatalog(['customers', 'orders', 'order_items']),
  );
  sourceId = (await backend.connectionCreate({ ...NEW_DRAFT, name: 'Dev' }, null)).id;
});
afterEach(() => vi.restoreAllMocks());

async function renderApp() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('toolbar', { name: 'Main toolbar' });
  // After startup, which reads the (empty) live sessions.
  act(() => useSessions.setState({ byId: { [sourceId]: { state: 'connected', info: INFO } } }));
  return user;
}

async function openPalette(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.keyboard('{Control>}{Shift>}a{/Shift}{/Control}');
  const dialog = screen.getByRole('dialog', { name: 'Search Everywhere' });
  const input = within(dialog).getByRole('combobox');
  expect(input).toHaveFocus();
  await user.type(input, text);
  return dialog;
}

const activeTab = () =>
  within(screen.getByRole('tablist', { name: 'Open editors' })).getByRole('tab', {
    selected: true,
  });

describe('search palette', () => {
  it('finds objects by name and opens the table viewer, data or DDL', async () => {
    const user = await renderApp();
    let dialog = await openPalette(user, 'ord');
    await within(dialog).findByRole('option', { name: /order_totals/ });
    const options = within(dialog).getAllByRole('option').slice(0, 4);
    // Best match first: the prefix matches, shortest name first; the other schema's table too.
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringMatching(/^orders.*table in shop/),
      expect.stringMatching(/^orders.*table in audit/),
      expect.stringMatching(/^order_items/),
      expect.stringMatching(/^order_totals/),
    ]);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(activeTab()).toHaveTextContent('orders'));
    expect(useWorkspace.getState().tabs[0]).toMatchObject({
      kind: 'object',
      object: { schema: 'shop', name: 'orders', objectType: 'table' },
    });

    dialog = await openPalette(user, 'shop.order_i');
    await within(dialog).findByRole('option', { name: /order_items/ });
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(activeTab()).toHaveTextContent('order_items (data)'));

    dialog = await openPalette(user, '/routines pri');
    expect(await within(dialog).findAllByRole('option')).toHaveLength(1);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(activeTab()).toHaveTextContent('DDL: shop.price(qty integer)'));
  });

  it('opens consoles and runs actions', async () => {
    const user = await renderApp();
    const name = await backend.consoleCreate('monthly report');
    await backend.consoleWrite(name, 'select 1');
    const dialog = await openPalette(user, '/consoles month');
    await within(dialog).findByRole('option', { name: /monthly report/ });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(activeTab()).toHaveTextContent('monthly report.sql'));

    const actions = await openPalette(user, '/actions settings');
    expect(within(actions).getByRole('option', { selected: true })).toHaveTextContent(/Settings/);
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
  });

  it('completes type prefixes with Tab and reveals objects in the explorer', async () => {
    const user = await renderApp();
    const dialog = await openPalette(user, '/ta');
    expect(within(dialog).getByText(/Tab completes \/tables/)).toBeVisible();
    await user.keyboard('{Tab}custom');
    expect(within(dialog).getByRole('combobox')).toHaveValue('/tables custom');
    await within(dialog).findByRole('option', { name: /customers/ });
    await user.keyboard('{Alt>}{Enter}{/Alt}');
    const row = await screen.findByRole('treeitem', { name: /^customers, table/ });
    await waitFor(() => expect(row).toHaveAttribute('aria-selected', 'true'));
  });
});

describe('go to DDL from the editor', () => {
  it('opens the table an aliased column reference belongs to', async () => {
    const user = await renderApp();
    await act(async () => void (await useWorkspace.getState().newConsole(sourceId)));
    const editor = (await screen.findByRole('textbox', { name: /SQL$/ })) as HTMLTextAreaElement;
    const text =
      'select o.customer_id\nfrom shop.orders o join shop.customers c on c.id = o.customer_id';
    await act(async () => {
      useWorkspace.getState().updateText(useWorkspace.getState().activeTabId ?? '', text);
    });
    editor.focus();
    // On "customer_id" of "o.customer_id".
    editor.setSelectionRange(11, 11);
    await user.keyboard('{Control>}b{/Control}');
    await waitFor(() => expect(activeTab()).toHaveTextContent('orders'));
    expect(useWorkspace.getState().tabs[1]).toMatchObject({
      kind: 'object',
      object: { schema: 'shop', name: 'orders' },
    });

    // Back returns to the console.
    await user.keyboard('{Control>}{Alt>}{ArrowLeft}{/Alt}{/Control}');
    await waitFor(() => expect(activeTab()).toHaveTextContent('console.sql'));
    const console = (await screen.findByRole('textbox', { name: /SQL$/ })) as HTMLTextAreaElement;
    // On the alias "c" in "c.id": the customers table.
    console.focus();
    console.setSelectionRange(text.indexOf('c.id'), text.indexOf('c.id'));
    await user.keyboard('{Control>}b{/Control}');
    await waitFor(() => expect(activeTab()).toHaveTextContent('customers'));
  });
});
