import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { backend } from '../../ipc/client';
import type { MetaNode, MetadataRequest, ServerInfo, StatusEvent } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { NEW_DRAFT } from '../connections/model';
import { useSessions } from '../connections/sessionsStore';
import { useMetadata } from './metadataStore';

const INFO: ServerInfo = {
  version: 'PostgreSQL 16.15',
  serverVersion: '16.15',
  database: 'quarry_test',
  user: 'quarry',
  tls: false,
  readOnly: false,
  latencyMs: 5,
};

/** A small fake catalog, answered per request level like the Rust adapter. */
function catalog(tables: string[]): (id: string, r: MetadataRequest) => Promise<MetaNode[]> {
  return async (_id, r) => {
    switch (r.level) {
      case 'schemas':
        return [
          {
            key: 's:shop',
            kind: 'schema',
            name: 'shop',
            children: { level: 'schemaGroups', schema: 'shop' },
          },
        ];
      case 'schemaGroups':
        return [
          {
            key: 'g:tables',
            kind: 'group',
            name: 'Tables',
            count: tables.length,
            children: { level: 'objects', schema: r.schema, types: ['table'] },
          },
        ];
      case 'objects':
        return tables.map((t) => ({
          key: `o:${t}`,
          kind: 'table',
          name: t,
          children: { level: 'objectGroups', schema: r.schema, name: t, objectType: 'table' },
        }));
      case 'objectGroups':
        return [
          {
            key: 'g:columns',
            kind: 'group',
            name: 'Columns',
            count: 2,
            children: { level: 'columns', schema: r.schema, table: r.name },
          },
        ];
      case 'columns':
        return [
          { key: 'c:id', kind: 'column', name: 'id', detail: 'bigint', flags: ['pk', 'not null'] },
          { key: 'c:email', kind: 'column', name: 'email', detail: 'text', flags: ['not null'] },
        ];
      default:
        return [];
    }
  };
}

let emit: (e: StatusEvent) => void = () => {};

beforeEach(async () => {
  for (const c of await backend.connectionsList()) await backend.connectionDelete(c.id);
  useConnections.setState({ items: [], selectedId: null, error: null });
  useSessions.setState({ byId: {} });
  useMetadata.setState({ children: {}, expanded: {} });
  vi.spyOn(backend, 'onConnectionStatus').mockImplementation(async (cb) => {
    emit = cb;
    return () => {};
  });
  vi.spyOn(backend, 'connectionConnect').mockResolvedValue(INFO);
});
afterEach(() => vi.restoreAllMocks());

async function setup(tables = ['customers', 'orders']) {
  const meta = vi.spyOn(backend, 'metadataChildren').mockImplementation(catalog(tables));
  const p = await backend.connectionCreate({ ...NEW_DRAFT, name: 'Dev' }, 'pw');
  const user = userEvent.setup();
  render(<App />);
  const tree = await screen.findByRole('tree', { name: 'Data sources' });
  return { p, user, tree, meta };
}

describe('explorer metadata tree', () => {
  it('connects on expand and walks down to columns with the keyboard', async () => {
    const { p, user, tree, meta } = await setup();
    await user.click(screen.getByRole('treeitem', { name: /^Dev/ }));
    tree.focus();

    await user.keyboard('{ArrowRight}'); // expand data source -> connects, loads schemas
    expect(backend.connectionConnect).toHaveBeenCalledWith(p.id, null);
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

    act(() => emit({ state: 'lost', id: p.id, reason: 'server closed the connection' }));
    await waitFor(() =>
      expect(screen.queryByRole('treeitem', { name: 'shop, schema' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('treeitem', { name: /^Dev/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(useMetadata.getState().children[p.id]).toBeUndefined();
  });

  it('expands a 1,000-table level within the 1 s budget', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => `t_${String(i).padStart(4, '0')}`);
    const { p } = await setup(many);
    await act(async () => {
      await useSessions.getState().connect(p.id);
    });
    const tablesKey = [p.id, 's:shop', 'g:tables'].join('\u001f');
    await act(async () => {
      useMetadata.setState({
        expanded: { [p.id]: true, [[p.id, 's:shop'].join('\u001f')]: true },
      });
    });
    await screen.findByRole('treeitem', { name: /^Tables, folder, 1000/ });

    const started = performance.now();
    await act(async () => useMetadata.getState().setExpanded(tablesKey, true));
    await screen.findByRole('treeitem', { name: 't_0999, table' });
    const elapsed = performance.now() - started;
    expect(screen.getAllByRole('treeitem', { name: /, table$/ })).toHaveLength(1000);
    // jsdom is slower than WebKit/Chromium, so this bounds the real UI cost from above.
    expect(elapsed).toBeLessThan(1000);
  });
});
