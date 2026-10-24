import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { backend } from '../../ipc/client';
import type { AppError, ServerInfo } from '../../ipc/types';
import { useConnections } from './connectionsStore';
import { NEW_DRAFT } from './model';
import { useSessions } from './sessionsStore';

const INFO: ServerInfo = {
  version: 'PostgreSQL 16.15',
  serverVersion: '16.15',
  database: 'app',
  user: 'dev',
  tls: false,
  readOnly: false,
  latencyMs: 4,
};

const UNKNOWN_HOST: AppError = {
  kind: 'connect',
  connectKind: 'ssh_host_unknown',
  message: 'The SSH server host key is not trusted yet.',
  hint: 'Compare the fingerprint first.',
  tunnel: true,
  hostKey: {
    host: 'bastion.example.test',
    port: 22,
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:abcDEF123',
  },
};

beforeEach(async () => {
  for (const c of await backend.connectionsList()) {
    await backend.connectionDelete(c.id);
  }
  for (const p of await backend.sshProfilesList()) {
    await backend.sshProfileDelete(p.id);
  }
  useConnections.setState({ items: [], folders: [], sshProfiles: [], selectedId: null });
  useSessions.setState({ byId: {} });
  vi.spyOn(backend, 'onConnectionStatus').mockResolvedValue(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function renderTunnelled() {
  const ssh = await backend.sshProfileCreate(
    {
      name: 'Bastion',
      host: 'bastion.example.test',
      port: 22,
      username: 'deploy',
      auth: 'key',
      keyFile: '/home/me/.ssh/id_ed25519',
      saveMode: 'never',
    },
    null,
  );
  const p = await backend.connectionCreate(
    { ...NEW_DRAFT, name: 'Prod via SSH', sshProfileId: ssh.id },
    'pw',
  );
  const user = userEvent.setup();
  render(<App />);
  const row = await screen.findByRole('treeitem', { name: /Prod via SSH, .*via SSH tunnel/ });
  return { p, user, row };
}

async function connectFromMenu(user: ReturnType<typeof userEvent.setup>, row: HTMLElement) {
  await user.pointer({ keys: '[MouseRight]', target: row });
  await user.click(screen.getByRole('menuitem', { name: 'Connect' }));
}

describe('connect flow', () => {
  it('asks to trust an unknown SSH host key, then connects', async () => {
    const { p, user, row } = await renderTunnelled();
    const connect = vi
      .spyOn(backend, 'connectionConnect')
      .mockRejectedValueOnce(UNKNOWN_HOST)
      .mockResolvedValueOnce(INFO);
    const trust = vi.spyOn(backend, 'sshHostTrust').mockResolvedValue(null);
    await connectFromMenu(user, row);

    const dialog = await screen.findByRole('dialog', { name: 'Trust SSH Host?' });
    expect(within(dialog).getByText('SHA256:abcDEF123')).toBeVisible();
    expect(within(dialog).getByText('ssh-ed25519')).toBeVisible();
    // Cancel is focused: Enter must not trust a key by accident.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Trust and Connect' }));

    expect(trust).toHaveBeenCalledWith('bastion.example.test', 22, 'SHA256:abcDEF123');
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(connect).toHaveBeenLastCalledWith(p.id, null, null);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('warns loudly about a changed host key and connects nothing on cancel', async () => {
    const { user, row } = await renderTunnelled();
    const connect = vi.spyOn(backend, 'connectionConnect').mockRejectedValue({
      ...UNKNOWN_HOST,
      connectKind: 'ssh_host_changed',
      hostKey: { ...UNKNOWN_HOST.hostKey, expected: 'SHA256:old' },
    });
    const trust = vi.spyOn(backend, 'sshHostTrust');
    await connectFromMenu(user, row);

    const dialog = await screen.findByRole('dialog', { name: 'SSH Host Key Changed' });
    expect(within(dialog).getByText('SHA256:old')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Trust New Key and Connect' })).toBeVisible();
    await user.keyboard('{Escape}');
    expect(trust).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledTimes(1);
    // A cancelled prompt is not an error to show.
    expect(screen.queryByLabelText('Prod via SSH failed')).not.toBeInTheDocument();
  });

  it('asks for the SSH key passphrase, and again when it was wrong', async () => {
    const { p, user, row } = await renderTunnelled();
    const connect = vi
      .spyOn(backend, 'connectionConnect')
      .mockRejectedValueOnce({
        kind: 'connect',
        connectKind: 'ssh_secret_required',
        message: 'The key file is encrypted: enter its passphrase.',
        tunnel: true,
      })
      .mockRejectedValueOnce({
        kind: 'connect',
        connectKind: 'auth',
        message: 'The passphrase for key file /home/me/.ssh/id_ed25519 is wrong.',
        tunnel: true,
      })
      .mockResolvedValueOnce(INFO);
    await connectFromMenu(user, row);

    let prompt = await screen.findByRole('dialog', { name: 'Connect to Prod via SSH' });
    const field = within(prompt).getByLabelText(/Passphrase for SSH key \/home\/me/);
    expect(field).toHaveFocus();
    await user.keyboard('wrong{Enter}');

    prompt = await screen.findByRole('dialog', { name: 'Connect to Prod via SSH' });
    expect(await within(prompt).findByText(/passphrase .* is wrong/)).toBeVisible();
    expect(within(prompt).getByText('SSH: Authentication failed')).toBeVisible();
    await user.keyboard('right{Enter}');

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
    expect(connect).toHaveBeenNthCalledWith(2, p.id, null, 'wrong');
    expect(connect).toHaveBeenLastCalledWith(p.id, null, 'right');
  });

  it('shows a checklist pointing at the failing step, with Test Connection', async () => {
    const { user, row } = await renderTunnelled();
    vi.spyOn(backend, 'connectionConnect').mockRejectedValue({
      kind: 'connect',
      connectKind: 'tls',
      message: 'The server does not support TLS.',
      hint: 'Choose another SSL mode.',
    });
    const test = vi.spyOn(backend, 'connectionTest').mockResolvedValue(INFO);
    await connectFromMenu(user, row);

    const failure = await screen.findByLabelText('Prod via SSH failed');
    const checklist = within(failure).getByRole('list', { name: 'Connection checklist' });
    const items = within(checklist)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(items).toEqual([
      expect.stringMatching(/^SSH tunnel: passed/),
      expect.stringMatching(/^Server reachable: passed/),
      expect.stringMatching(/^TLS: failed/),
      expect.stringMatching(/^Credentials accepted: not checked/),
    ]);

    await user.click(within(failure).getByRole('button', { name: 'Test Connection' }));
    await waitFor(() => expect(test).toHaveBeenCalled());
    expect(await within(failure).findByText(/Connected/)).toBeVisible();
    expect(
      within(checklist)
        .getAllByRole('listitem')
        .every((li) => li.textContent?.includes('passed')),
    ).toBe(true);
  });
});
