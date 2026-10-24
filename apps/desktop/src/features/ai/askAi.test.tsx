import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { resetHydrationForTests, useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import { DEFAULT_AI_SETTINGS, type Environment } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { NEW_DRAFT } from '../connections/model';
import { useAi } from './aiStore';

beforeEach(async () => {
  for (const c of await backend.connectionsList()) {
    await backend.connectionDelete(c.id);
  }
  for (const c of await backend.aiConsentsList()) {
    await backend.aiConsentRevoke(c.connectionId);
  }
  await backend.aiLogClear();
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
  await backend.aiKeySet('sk-ant-test');
  await backend.aiSettingsSet({ ...DEFAULT_AI_SETTINGS, enabled: true });
  vi.spyOn(backend, 'onConnectionStatus').mockResolvedValue(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function consoleFor(environment: Environment) {
  const source = await backend.connectionCreate(
    { ...NEW_DRAFT, name: `${environment} db`, environment },
    null,
  );
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('toolbar', { name: 'Main toolbar' });
  await act(async () => {
    await useConnections.getState().load();
    await useAi.getState().load();
  });
  await act(async () => void (await useWorkspace.getState().newConsole(source.id)));
  const editor = (await screen.findByRole('textbox', { name: /SQL$/ })) as HTMLTextAreaElement;
  editor.focus();
  return { user, editor, source };
}

async function ask(user: ReturnType<typeof userEvent.setup>, question: string) {
  await user.keyboard('{Control>}{Alt>}a{/Alt}{/Control}');
  const dialog = await screen.findByRole('dialog', { name: 'Ask AI' });
  await user.type(within(dialog).getByLabelText('Question or request'), question);
  await user.click(within(dialog).getByRole('button', { name: 'Preview Request' }));
  return dialog;
}

describe('Ask AI: consent, preview, send, log', () => {
  it('asks for consent first, shows the exact request, and logs exactly what was sent', async () => {
    const { user } = await consoleFor('development');
    await user.keyboard('select count(*) from orders');
    const dialog = await ask(user, 'What does this do?');

    const consent = await screen.findByRole('dialog', { name: 'AI context for development db' });
    expect(within(consent).getByRole('radio', { name: /^SQL and schema/ })).toBeChecked();
    await user.click(within(consent).getByRole('radio', { name: /^SQL text only/ }));
    await user.click(within(consent).getByRole('button', { name: 'Continue' }));

    const preview = await within(dialog).findByRole('region', { name: 'What will be sent' });
    expect(preview).toHaveTextContent('SQL text only');
    await user.click(within(preview).getByText('What will be sent (exact text)'));
    const body = within(preview).getByLabelText('Request text').textContent ?? '';
    expect(body).toContain('select count(*) from orders');
    expect(body).toContain('What does this do?');
    expect(preview).toHaveTextContent(`${new TextEncoder().encode(body).length} bytes`);

    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    const answer = within(dialog).getByRole('log', { name: 'Answer' });
    await waitFor(() => expect(answer).toHaveTextContent('SELECT 1;'));
    expect(await within(dialog).findByRole('button', { name: 'Close' })).toBeVisible();

    const [entry] = await backend.aiLogList(10);
    expect(entry?.payload).toBe(body);
    expect(entry?.status).toBe('done');
    expect(entry?.payload).not.toContain('sk-ant-test');

    // The choice is kept for this run: the next request does not ask again.
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await ask(user, 'Again');
    expect(await screen.findByRole('region', { name: 'What will be sent' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: /^AI context for/ })).toBeNull();
  });

  it('production sources preselect SQL text only', async () => {
    const { user } = await consoleFor('production');
    await ask(user, 'Why is this slow?');
    const consent = await screen.findByRole('dialog', { name: 'AI context for production db' });
    expect(within(consent).getByRole('radio', { name: /^SQL text only/ })).toBeChecked();
    expect(consent).toHaveTextContent('This is a production data source');
    await user.click(within(consent).getByRole('button', { name: 'Cancel' }));
    // Cancelled: nothing previewed, nothing sent.
    expect(screen.queryByRole('region', { name: 'What will be sent' })).toBeNull();
    expect(await backend.aiLogList(10)).toEqual([]);
  });

  it('sample rows need their own consent each time', async () => {
    const { user, source } = await consoleFor('development');
    await backend.aiConsentSet(source.id, 'schemaAndRows', false, false);
    // Not connected here, so no catalog: stand in for the objects the SQL references.
    const realPreview = backend.aiContextPreview;
    vi.spyOn(backend, 'aiContextPreview').mockImplementation((request) =>
      realPreview({
        ...request,
        objects: [{ schema: 'shop', name: 'orders', objectType: 'table' }],
      }),
    );
    await user.keyboard('select * from shop.orders');
    const dialog = await ask(user, 'Summarize');
    const rows = await screen.findByRole('dialog', { name: 'Send sample rows?' });
    expect(within(rows).getByRole('list', { name: 'Sample rows' })).toHaveTextContent(
      'Up to 5 rows from shop.orders',
    );
    await user.click(within(rows).getByRole('button', { name: 'Without Rows' }));
    const preview = await within(dialog).findByRole('region', { name: 'What will be sent' });
    expect(preview).not.toHaveTextContent('Sample rows');

    await user.click(within(dialog).getByRole('button', { name: 'Back' }));
    await user.click(within(dialog).getByRole('button', { name: 'Preview Request' }));
    const again = await screen.findByRole('dialog', { name: 'Send sample rows?' });
    await user.click(within(again).getByRole('button', { name: 'Include Rows' }));
    const withRows = await within(dialog).findByRole('region', { name: 'What will be sent' });
    expect(withRows).toHaveTextContent('Sample rows1 from shop.orders');
  });

  it('revoking in Settings asks again, and the log can be viewed and cleared', async () => {
    const { user, source } = await consoleFor('development');
    await backend.aiConsentSet(source.id, 'schema', true, false);
    const dialog = await ask(user, 'Hello');
    await user.click(await within(dialog).findByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('log', { name: 'Answer' })).toHaveTextContent('SELECT 1;'),
    );
    await user.click(await within(dialog).findByRole('button', { name: 'Close' }));

    await user.keyboard('{Control>}{Alt>}s{/Alt}{/Control}');
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    await user.click(within(settings).getByRole('tab', { name: 'AI' }));
    const consents = await within(settings).findByRole('list', {
      name: 'AI context per data source',
    });
    expect(consents).toHaveTextContent('development db');
    expect(consents).toHaveTextContent('SQL and schema');
    const requests = within(settings).getByRole('list', { name: 'AI requests' });
    await user.click(within(requests).getByRole('button', { name: /development db: ask/ }));
    expect(within(requests).getByLabelText('Sent request')).toHaveTextContent('Hello');
    expect(within(requests).getByLabelText('Answer received')).toHaveTextContent('SELECT 1;');

    await user.click(
      within(consents).getByRole('button', { name: 'Revoke AI context for development db' }),
    );
    await waitFor(() =>
      expect(
        within(settings).queryByRole('list', { name: 'AI context per data source' }),
      ).toBeNull(),
    );
    expect((await backend.aiConsentGet(source.id)).decided).toBe(false);

    await user.click(within(settings).getByRole('button', { name: 'Clear Log' }));
    const confirm = await screen.findByRole('dialog', { name: 'Clear the AI request log?' });
    await user.click(within(confirm).getByRole('button', { name: 'Clear Log' }));
    expect(await within(settings).findByText('No requests yet.')).toBeVisible();
  });

  it('is hidden from the palette and explains itself while AI is off', async () => {
    await backend.aiSettingsSet({ ...DEFAULT_AI_SETTINGS, enabled: false });
    const { user } = await consoleFor('development');
    await user.keyboard('{Control>}{Alt>}a{/Alt}{/Control}');
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull();
    expect(await screen.findByText(/AI is off/)).toBeVisible();
  });
});
