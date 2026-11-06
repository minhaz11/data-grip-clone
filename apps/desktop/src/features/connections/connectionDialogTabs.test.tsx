import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { backend } from '../../ipc/client';
import type { ServerInfo } from '../../ipc/types';
import { useConnections } from './connectionsStore';
import { NEW_DRAFT } from './model';

const INFO: ServerInfo = {
  version: 'PostgreSQL 16.15',
  serverVersion: '16.15',
  database: 'app',
  user: 'dev',
  tls: true,
  readOnly: false,
  latencyMs: 4,
};

async function clearAll() {
  for (const c of await backend.connectionsList()) {
    await backend.connectionDelete(c.id);
  }
  for (const p of await backend.sshProfilesList()) {
    await backend.sshProfileDelete(p.id);
  }
  for (const f of await backend.foldersList()) {
    await backend.folderDelete(f.id);
  }
  useConnections.setState({ items: [], folders: [], sshProfiles: [], selectedId: null });
}

async function openNewDialog(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await screen.findByRole('toolbar', { name: 'Main toolbar' });
  await user.keyboard('{Alt>}{Insert}{/Alt}');
  return screen.getByRole('dialog', { name: 'New PostgreSQL Data Source' });
}

const tab = (dialog: HTMLElement, name: string | RegExp) =>
  within(dialog).getByRole('tab', { name });

describe('connection dialog tabs', () => {
  beforeEach(clearAll);
  afterEach(() => vi.restoreAllMocks());

  it('keeps the URL and the fields in sync and moves a URL password out', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(backend, 'connectionCreate');
    const dialog = await openNewDialog(user);
    const url = within(dialog).getByLabelText('URL');
    expect(url).toHaveValue('postgresql://postgres@localhost/postgres');

    await user.clear(within(dialog).getByLabelText('Host'));
    await user.type(within(dialog).getByLabelText('Host'), 'db.internal');
    expect(url).toHaveValue('postgresql://postgres@db.internal/postgres');

    await user.clear(url);
    await user.click(url);
    await user.paste('postgresql://ann:s3cret@[::1]:6543/shop?sslmode=require');
    expect(url).toHaveValue('postgresql://ann@[::1]:6543/shop?sslmode=require');
    expect(within(dialog).getByText(/password was moved to the Password field/)).toBeVisible();
    expect(within(dialog).getByLabelText('Host')).toHaveValue('::1');
    expect(within(dialog).getByLabelText('Port')).toHaveValue(6543);
    expect(within(dialog).getByLabelText('User')).toHaveValue('ann');
    expect(within(dialog).getByLabelText('Password')).toHaveValue('s3cret');

    await user.type(within(dialog).getByLabelText('Name'), 'From URL');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ host: '::1', port: 6543, database: 'shop', sslMode: 'require' }),
        's3cret',
      ),
    );
  });

  it('shows URL errors and keeps the fields unchanged', async () => {
    const user = userEvent.setup();
    const dialog = await openNewDialog(user);
    const url = within(dialog).getByLabelText('URL');
    await user.clear(url);
    await user.type(url, 'mysql://x');
    expect(within(dialog).getByText(/Enter a URL like postgresql/)).toBeVisible();
    expect(within(dialog).getByLabelText('Host')).toHaveValue('localhost');
  });

  it('URL only mode hides the separate endpoint fields', async () => {
    const user = userEvent.setup();
    const dialog = await openNewDialog(user);
    await user.selectOptions(within(dialog).getByLabelText('Connection type'), 'url');
    expect(within(dialog).queryByLabelText('Host')).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('URL')).toBeVisible();
  });

  it('jumps to the tab with an error on save', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(backend, 'connectionCreate');
    const dialog = await openNewDialog(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Certs');
    await user.click(tab(dialog, 'TLS'));
    await user.type(within(dialog).getByLabelText('Client certificate'), '/etc/me.pem');
    await user.click(tab(dialog, 'General'));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(tab(dialog, /TLS/)).toHaveAttribute('aria-selected', 'true');
    expect(within(dialog).getByText(/go together: choose both/)).toBeVisible();
    expect(create).not.toHaveBeenCalled();
  });

  it('tests through an unsaved SSH profile, then saves both', async () => {
    const user = userEvent.setup();
    const test = vi.spyOn(backend, 'connectionTest').mockResolvedValue(INFO);
    const createSsh = vi.spyOn(backend, 'sshProfileCreate');
    const create = vi.spyOn(backend, 'connectionCreate');
    const dialog = await openNewDialog(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Behind bastion');

    await user.click(tab(dialog, 'SSH'));
    await user.click(within(dialog).getByLabelText('Connect through an SSH tunnel'));
    await user.type(within(dialog).getByLabelText('SSH host'), 'bastion.example.test');
    await user.type(within(dialog).getByLabelText('SSH user'), 'deploy');
    await user.selectOptions(within(dialog).getByLabelText('Authentication'), 'password');
    await user.type(
      within(dialog).getByLabelText('Password', { selector: '#ds-panel-ssh input' }),
      'tunnel-pw',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Test Connection' }));
    await waitFor(() =>
      expect(test).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Behind bastion', sshProfileId: null }),
        null,
        null,
        {
          profile: expect.objectContaining({
            name: 'deploy@bastion.example.test',
            host: 'bastion.example.test',
            auth: 'password',
          }),
          secret: 'tunnel-pw',
        },
      ),
    );

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(createSsh).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'bastion.example.test', username: 'deploy' }),
      'tunnel-pw',
    );
    const ssh = (await backend.sshProfilesList())[0];
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ sshProfileId: ssh?.id }), null);
  });

  it('loads schemas and saves the chosen scope', async () => {
    const user = userEvent.setup();
    vi.spyOn(backend, 'connectionSchemas').mockResolvedValue(['public', 'shop', 'audit']);
    const create = vi.spyOn(backend, 'connectionCreate');
    const dialog = await openNewDialog(user);
    await user.type(within(dialog).getByLabelText('Name'), 'Scoped');
    await user.click(tab(dialog, 'Schemas'));
    expect(within(dialog).getByText(/All schemas are loaded/)).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Load Schemas' }));
    const list = await within(dialog).findByRole('list', { name: 'Schemas to load' });
    await user.click(within(list).getByLabelText('shop'));
    await user.type(within(dialog).getByLabelText('Pattern'), 'aud*');
    expect(within(dialog).getByText('2 of 3 schemas are loaded.')).toBeVisible();
    expect(within(list).getByText('matches pattern')).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ schemaNames: ['shop'], schemaPattern: 'aud*' }),
        null,
      ),
    );
  });

  it('saves options and keeps them when reopened', async () => {
    const user = userEvent.setup();
    await backend.connectionCreate(
      { ...NEW_DRAFT, name: 'Opts', keepaliveSecs: 30, startupSql: 'SET search_path = app' },
      null,
    );
    render(<App />);
    const row = await screen.findByRole('treeitem', { name: /Opts/ });
    await user.dblClick(row);
    const dialog = screen.getByRole('dialog', { name: 'Data Source: Opts' });
    await user.click(tab(dialog, 'Options'));
    expect(within(dialog).getByLabelText('Keep-alive')).toHaveValue(30);
    expect(within(dialog).getByLabelText('Startup SQL')).toHaveValue('SET search_path = app');
    await user.clear(within(dialog).getByLabelText('Auto-disconnect'));
    await user.type(within(dialog).getByLabelText('Auto-disconnect'), '1441');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText(/between 0 and 1440 minutes/)).toBeVisible();
  });
});
