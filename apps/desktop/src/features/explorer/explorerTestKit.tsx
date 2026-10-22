// Shared harness for explorer UI tests (fake catalog, mocked sessions, rendered app).
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, vi } from 'vitest';
import { App } from '../../app/App';
import { backend } from '../../ipc/client';
import type { MetaNode, MetadataRequest, ServerInfo, StatusEvent } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { NEW_DRAFT } from '../connections/model';
import { useSessions } from '../connections/sessionsStore';
import { useMetadata } from './metadataStore';

export const INFO: ServerInfo = {
  version: 'PostgreSQL 16.15',
  serverVersion: '16.15',
  database: 'quarry_test',
  user: 'quarry',
  tls: false,
  readOnly: false,
  latencyMs: 5,
};

/** A small fake catalog, answered per request level like the Rust adapter. */
export function catalog(tables: string[]): (id: string, r: MetadataRequest) => Promise<MetaNode[]> {
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
          {
            key: 'g:routines',
            kind: 'group',
            name: 'Routines',
            count: 1,
            children: { level: 'routines', schema: r.schema },
          },
        ];
      case 'routines':
        return [
          {
            key: 'r:price(qty integer)',
            kind: 'routine',
            name: 'price',
            detail: '(qty integer) → numeric',
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

/** Sends a session status event to the UI, as the backend would. */
export function emitStatus(e: StatusEvent): void {
  emit(e);
}

/** Registers the per-test reset and mocks; call once at the top of a test file. */
export function registerExplorerHarness(): void {
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
}

export async function setup(tables = ['customers', 'orders']) {
  const meta = vi.spyOn(backend, 'metadataChildren').mockImplementation(catalog(tables));
  const p = await backend.connectionCreate({ ...NEW_DRAFT, name: 'Dev' }, 'pw');
  const user = userEvent.setup();
  render(<App />);
  const tree = await screen.findByRole('tree', { name: 'Data sources' });
  return { p, user, tree, meta };
}
