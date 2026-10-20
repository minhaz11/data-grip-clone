import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { backend } from '../../ipc/client';
import type { ServerInfo, StatusEvent } from '../../ipc/types';
import { useConnections } from './connectionsStore';
import { NEW_DRAFT } from './model';
import { useSessions } from './sessionsStore';

const INFO: ServerInfo = {
  version: 'PostgreSQL 16.15 on x86_64',
  serverVersion: '16.15',
  database: 'quarry_test',
  user: 'quarry',
  tls: true,
  readOnly: false,
  latencyMs: 12,
};

let emit: (e: StatusEvent) => void = () => {};

beforeEach(async () => {
  for (const c of await backend.connectionsList()) await backend.connectionDelete(c.id);
  useConnections.setState({ items: [], selectedId: null, error: null });
  useSessions.setState({ byId: {} });
  vi.spyOn(backend, 'onConnectionStatus').mockImplementation(async (cb) => {
    emit = cb;
    return () => {};
  });
});
afterEach(() => vi.restoreAllMocks());

async function renderWithSource(name = 'Dev DB') {
  const p = await backend.connectionCreate({ ...NEW_DRAFT, name }, 'pw');
  render(<App />);
  await screen.findByRole('treeitem', { name: new RegExp(name) });
  return p;
}

describe('connectivity UI', () => {
  it('tests a draft and shows server details', async () => {
    const user = userEvent.setup();
    const test = vi.spyOn(backend, 'connectionTest').mockResolvedValue(INFO);
    render(<App />);
    await screen.findByRole('toolbar', { name: 'Main toolbar' });
    await user.keyboard('{Alt>}{Insert}{/Alt}');
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Scratch');
    await user.type(within(dialog).getByLabelText('Password'), 'typed');
    await user.click(within(dialog).getByRole('button', { name: 'Test Connection' }));

    expect(test).toHaveBeenCalledWith(expect.objectContaining({ name: 'Scratch' }), null, 'typed');
    const status = await within(dialog).findByRole('status');
    expect(status).toHaveTextContent('Connected — PostgreSQL 16.15');
    expect(status).toHaveTextContent('quarry@quarry_test · TLS on · 12 ms');
  });

  it('reuses the stored password when testing an existing profile', async () => {
    const user = userEvent.setup();
    const test = vi.spyOn(backend, 'connectionTest').mockResolvedValue(INFO);
    const p = await renderWithSource();
    await user.dblClick(screen.getByRole('treeitem', { name: /Dev DB/ }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Test Connection' }),
    );
    expect(test).toHaveBeenCalledWith(expect.anything(), p.id, null);
  });

  it('renders categorized failures with hint and SQLSTATE', async () => {
    const user = userEvent.setup();
    vi.spyOn(backend, 'connectionTest').mockRejectedValue({
      kind: 'connect',
      connectKind: 'database_missing',
      message: 'database "nope" does not exist (3D000).',
      hint: 'Check the name.',
      sqlstate: '3D000',
    });
    render(<App />);
    await screen.findByRole('toolbar', { name: 'Main toolbar' });
    await user.keyboard('{Alt>}{Insert}{/Alt}');
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'X');
    await user.click(within(dialog).getByRole('button', { name: 'Test Connection' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Database not found');
    expect(alert).toHaveTextContent('Check the name.');
    expect(alert).toHaveTextContent('SQLSTATE 3D000');
  });

  it('prompts for a password when the server requires one, then connects', async () => {
    const user = userEvent.setup();
    const connect = vi
      .spyOn(backend, 'connectionConnect')
      .mockRejectedValueOnce({
        kind: 'connect',
        connectKind: 'password_required',
        message: 'needs pw',
        hint: 'Enter it.',
      })
      .mockResolvedValueOnce(INFO);
    const p = await renderWithSource();

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('treeitem', { name: /Dev DB/ }),
    });
    await user.click(screen.getByRole('menuitem', { name: 'Connect' }));
    const prompt = await screen.findByRole('dialog', { name: 'Connect to Dev DB' });
    // The prompt focuses its password field on open; type straight into it.
    expect(within(prompt).getByLabelText(/Password for/)).toHaveFocus();
    await user.keyboard('secret');
    await user.click(within(prompt).getByRole('button', { name: 'Connect' }));

    expect(connect).toHaveBeenLastCalledWith(p.id, 'secret');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      screen.getByRole('treeitem', { name: /connected \(PostgreSQL 16\.15\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Selected data source')).toHaveTextContent(
      'connected · PostgreSQL 16.15',
    );
  });

  it('reflects a session lost on the server side and offers Connect again', async () => {
    const user = userEvent.setup();
    vi.spyOn(backend, 'connectionConnect').mockResolvedValue(INFO);
    const p = await renderWithSource();
    await act(() => useSessions.getState().connect(p.id));
    expect(screen.getByRole('treeitem', { name: /connected/ })).toBeInTheDocument();

    act(() =>
      emit({
        state: 'lost',
        id: p.id,
        reason: 'terminating connection due to administrator command',
      }),
    );
    expect(
      screen.getByRole('treeitem', { name: /connection lost: terminating connection/ }),
    ).toBeInTheDocument();
    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('treeitem', { name: /Dev DB/ }),
    });
    expect(screen.getByRole('menuitem', { name: 'Connect' })).toBeInTheDocument();
  });

  it('says plainly that a browser build cannot connect', async () => {
    const user = userEvent.setup();
    await renderWithSource();
    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByRole('treeitem', { name: /Dev DB/ }),
    });
    await user.click(screen.getByRole('menuitem', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('requires the Quarry desktop app');
  });
});
