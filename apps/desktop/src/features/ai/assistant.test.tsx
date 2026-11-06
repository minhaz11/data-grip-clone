import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { App } from '../../app/App';
import { resetHydrationForTests, useWorkspace } from '../../app/workspaceStore';
import { backend, type Backend } from '../../ipc/client';
import {
  DEFAULT_AI_SETTINGS,
  type AiStreamEvent,
  type ConnectionDraft,
  type ServerInfo,
} from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { NEW_DRAFT } from '../connections/model';
import { useSessions } from '../connections/sessionsStore';
import { useExec } from '../exec/execStore';
import { useAi } from './aiStore';
import { useAssistant } from './assistantStore';

const INFO: ServerInfo = {
  version: 'PostgreSQL 16.15',
  serverVersion: '16.15',
  database: 'quarry_test',
  user: 'quarry',
  tls: false,
  readOnly: false,
  latencyMs: 3,
};

let execute: MockInstance<Backend['queryExecute']>;

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
  useConnections.setState({ items: [], selectedId: null, error: null });
  useSessions.setState({ byId: {} });
  useExec.setState({ runs: {}, view: {} });
  // Drops any answer still streaming from the previous test.
  useAssistant.getState().reset();
  useAssistant.setState({ open: false, context: null });
  await backend.aiKeySet('sk-ant-test');
  await backend.aiSettingsSet({ ...DEFAULT_AI_SETTINGS, enabled: true });
  vi.spyOn(backend, 'onConnectionStatus').mockResolvedValue(() => {});
  vi.spyOn(backend, 'connectionConnect').mockResolvedValue(INFO);
  execute = vi.spyOn(backend, 'queryExecute');
});
afterEach(() => vi.restoreAllMocks());

/** A console bound to a fresh data source, with `text` typed in it. */
async function consoleWith(text: string, draft: Partial<ConnectionDraft> = {}) {
  const source = await backend.connectionCreate({ ...NEW_DRAFT, name: 'Dev', ...draft }, null);
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('toolbar', { name: 'Main toolbar' });
  await act(async () => {
    await useConnections.getState().load();
    await useAi.getState().load();
    const id = await useWorkspace.getState().newConsole(source.id);
    useWorkspace.getState().setSource(id, source.id);
  });
  const editor = (await screen.findByRole('textbox', { name: /SQL$/ })) as HTMLTextAreaElement;
  editor.focus();
  if (text) {
    await user.keyboard(text);
  }
  return { user, editor, source };
}

/** The answer the AI streams for the next Send. */
function answerWith(text: string) {
  const send = backend.aiSend;
  vi.spyOn(backend, 'aiSend').mockImplementation(async (payloadId, onEvent) => {
    // The real send logs the previewed payload; then the answer is replaced.
    const id = await send(payloadId, () => {});
    queueMicrotask(() => {
      const events: AiStreamEvent[] = [
        { type: 'started', model: 'claude-sonnet-5-5' },
        { type: 'text', text },
        {
          type: 'done',
          stopReason: 'end_turn',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      ];
      events.forEach(onEvent);
    });
    return id;
  });
}

function panel() {
  return screen.getByRole('complementary', { name: 'AI assistant' });
}

async function chooseContext(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
  const consent = await screen.findByRole('dialog', { name: /^AI context for/ });
  await user.click(within(consent).getByRole('radio', { name: label }));
  await user.click(within(consent).getByRole('button', { name: 'Continue' }));
}

async function generate(user: ReturnType<typeof userEvent.setup>, request: string) {
  await user.keyboard('{Control>}{Alt>}a{/Alt}{/Control}');
  const prompt = await within(panel()).findByLabelText('Ask, or describe the SQL you need');
  // In jsdom the panel library takes every click for its separator; focus the field directly.
  prompt.focus();
  await user.keyboard(request);
  await user.click(within(panel()).getByRole('button', { name: 'Generate SQL' }));
}

describe('AI assistant panel', () => {
  it('asks for consent, shows the exact request, and logs exactly what was sent', async () => {
    const { user } = await consoleWith('select count(*) from orders');
    await generate(user, 'per day');
    const consent = await screen.findByRole('dialog', { name: 'AI context for Dev' });
    expect(within(consent).getByRole('radio', { name: /^SQL and schema/ })).toBeChecked();
    await chooseContext(user, /^SQL text only/);

    const preview = await within(panel()).findByRole('region', { name: 'What will be sent' });
    expect(preview).toHaveTextContent('SQL text only');
    await user.click(within(preview).getByText('What will be sent (exact text)'));
    const body = within(preview).getByLabelText('Request text').textContent ?? '';
    expect(body).toContain('select count(*) from orders');
    expect(body).toContain('Request: per day');
    expect(preview).toHaveTextContent(`${new TextEncoder().encode(body).length} bytes`);

    await user.click(within(panel()).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(within(panel()).getByRole('log', { name: 'Answer' })).toHaveTextContent('SELECT 1;'),
    );
    const [entry] = await backend.aiLogList(10);
    expect(entry?.payload).toBe(body);
    expect(entry?.action).toBe('generate');
    expect(entry?.payload).not.toContain('sk-ant-test');
  });

  it('production sources preselect SQL text only, and Cancel sends nothing', async () => {
    const { user } = await consoleWith('select 1', { environment: 'production' });
    await generate(user, 'anything');
    const consent = await screen.findByRole('dialog', { name: 'AI context for Dev' });
    expect(within(consent).getByRole('radio', { name: /^SQL text only/ })).toBeChecked();
    expect(consent).toHaveTextContent('This is a production data source');
    await user.click(within(consent).getByRole('button', { name: 'Cancel' }));
    expect(within(panel()).queryByRole('region', { name: 'What will be sent' })).toBeNull();
    expect(await backend.aiLogList(10)).toEqual([]);
  });

  it('sample rows need their own consent each time', async () => {
    const { user, source } = await consoleWith('select * from shop.orders');
    await backend.aiConsentSet(source.id, 'schemaAndRows', false, false);
    // Not connected here, so no catalog: stand in for the objects the SQL references.
    const realPreview = backend.aiContextPreview;
    vi.spyOn(backend, 'aiContextPreview').mockImplementation((request) =>
      realPreview({
        ...request,
        objects: [{ schema: 'shop', name: 'orders', objectType: 'table' }],
      }),
    );
    await generate(user, 'summarize');
    const rows = await screen.findByRole('dialog', { name: 'Send sample rows?' });
    expect(within(rows).getByRole('list', { name: 'Sample rows' })).toHaveTextContent(
      'Up to 5 rows from shop.orders',
    );
    await user.click(within(rows).getByRole('button', { name: 'Without Rows' }));
    const preview = await within(panel()).findByRole('region', { name: 'What will be sent' });
    expect(preview).not.toHaveTextContent('Sample rows');

    await user.click(within(panel()).getByRole('button', { name: 'Back' }));
    await user.click(within(panel()).getByRole('button', { name: 'Generate SQL' }));
    const again = await screen.findByRole('dialog', { name: 'Send sample rows?' });
    await user.click(within(again).getByRole('button', { name: 'Include Rows' }));
    expect(
      await within(panel()).findByRole('region', { name: 'What will be sent' }),
    ).toHaveTextContent('Sample rows1 from shop.orders');
  });

  it('inserts generated SQL without running it; Run then asks before a destructive statement', async () => {
    const { user, editor, source } = await consoleWith('');
    await backend.aiConsentSet(source.id, 'none', true, false);
    answerWith('Here it is:\n```sql\nDELETE FROM t;\n```\nThis removes every row.');
    await generate(user, 'empty table t');
    await user.click(await within(panel()).findByRole('button', { name: 'Send' }));
    const proposal = await within(panel()).findByRole('region', { name: 'Proposed SQL' });
    expect(proposal).toHaveTextContent('DELETE FROM t;');
    await user.click(within(proposal).getByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(editor.value).toBe('DELETE FROM t;'));
    expect(execute).not.toHaveBeenCalled();

    // Running it goes through the normal guards.
    editor.focus();
    await user.keyboard('{Control>}{Enter}{/Control}');
    const confirm = await screen.findByRole('dialog', { name: 'Run destructive statement?' });
    expect(confirm).toHaveTextContent('DELETE without WHERE affects every row');
    await user.keyboard('{Escape}');
    expect(execute).not.toHaveBeenCalled();
  });

  it('on a read-only source, inserted write SQL is still blocked', async () => {
    const { user, editor, source } = await consoleWith('', { readOnly: true });
    await backend.aiConsentSet(source.id, 'none', true, false);
    answerWith('```sql\nUPDATE accounts SET balance = 0 WHERE id = 1;\n```');
    await generate(user, 'zero the balance of account 1');
    await user.click(await within(panel()).findByRole('button', { name: 'Send' }));
    await user.click(await within(panel()).findByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(editor.value).toContain('UPDATE accounts'));
    editor.focus();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByText(/"Dev" is read-only/)).toBeVisible();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fixes a failed statement from the output as a diff, and replaces only that statement', async () => {
    execute.mockImplementation(async (req, onEvent) => {
      queueMicrotask(() => {
        onEvent({ event: 'statementStarted', index: 0, offset: req.statements[0]?.offset ?? 0 });
        onEvent({
          event: 'statementFailed',
          index: 0,
          offset: req.statements[0]?.offset ?? 0,
          elapsedMs: 2,
          error: {
            message: 'column "emial" does not exist',
            detail: null,
            sqlstate: '42703',
            position: 8,
            hint: null,
            cancelled: false,
            connectionLost: false,
          },
        });
        onEvent({ event: 'finished', status: 'failed', executed: 1, elapsedMs: 3 });
      });
      return 'job-1';
    });
    const { user, editor, source } = await consoleWith('select 1;\nselect emial from users;');
    await backend.aiConsentSet(source.id, 'none', true, false);
    await user.keyboard('{Control>}{Enter}{/Control}');
    const output = await screen.findByLabelText('Statement output');
    await waitFor(() => expect(output).toHaveTextContent('column "emial" does not exist'));
    expect(execute).toHaveBeenCalledTimes(1);

    answerWith('```sql\nselect email from users\n```\nThe column is called email.');
    await user.click(within(output).getByRole('button', { name: 'Fix with AI' }));
    const preview = await within(panel()).findByRole('region', { name: 'What will be sent' });
    await user.click(within(preview).getByText('What will be sent (exact text)'));
    const body = within(preview).getByLabelText('Request text');
    expect(body).toHaveTextContent('ERROR 42703: column \\"emial\\" does not exist');
    expect(body).toHaveTextContent('select emial from users');
    await user.click(within(panel()).getByRole('button', { name: 'Send' }));
    const proposal = await within(panel()).findByRole('region', { name: 'Proposed SQL' });
    expect(within(proposal).getByLabelText('removed').closest('tr')).toHaveTextContent(
      'select emial from users',
    );
    expect(within(proposal).getByLabelText('added').closest('tr')).toHaveTextContent(
      'select email from users',
    );
    await user.click(within(proposal).getByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(editor.value).toBe('select 1;\nselect email from users;'));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('explains a query without offering to insert anything', async () => {
    const { user, source } = await consoleWith('select * from orders');
    await backend.aiConsentSet(source.id, 'none', true, false);
    answerWith('It reads every row of orders. For example:\n```sql\nSELECT 1;\n```');
    await user.keyboard('{Control>}{Alt>}a{/Alt}{/Control}');
    await user.click(await within(panel()).findByRole('button', { name: 'Explain Query' }));
    const preview = await within(panel()).findByRole('region', { name: 'What will be sent' });
    await user.click(within(preview).getByText('What will be sent (exact text)'));
    expect(within(preview).getByLabelText('Request text')).toHaveTextContent(
      'Explain what the SQL in the editor does',
    );
    await user.click(within(panel()).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(within(panel()).getByRole('log', { name: 'Answer' })).toHaveTextContent(
        'It reads every row',
      ),
    );
    expect(within(panel()).queryByRole('region', { name: 'Proposed SQL' })).toBeNull();
    expect(
      within(panel()).getByRole('heading', { name: 'Explanation of the query' }),
    ).toBeVisible();
  });

  it('revoking in Settings asks again; the log can be viewed and cleared', async () => {
    const { user, source } = await consoleWith('select 1');
    await backend.aiConsentSet(source.id, 'schema', true, false);
    await generate(user, 'hello');
    await user.click(await within(panel()).findByRole('button', { name: 'Send' }));
    // The proposal shows once the answer is complete (and logged).
    await within(panel()).findByRole('region', { name: 'Proposed SQL' });

    await user.keyboard('{Control>}{Alt>}s{/Alt}{/Control}');
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    await user.click(within(settings).getByRole('tab', { name: 'AI' }));
    const consents = await within(settings).findByRole('list', {
      name: 'AI context per data source',
    });
    expect(consents).toHaveTextContent('Dev');
    expect(consents).toHaveTextContent('SQL and schema');
    const requests = within(settings).getByRole('list', { name: 'AI requests' });
    await user.click(within(requests).getByRole('button', { name: /Dev: generate/ }));
    expect(within(requests).getByLabelText('Sent request')).toHaveTextContent('hello');
    expect(within(requests).getByLabelText('Answer received')).toHaveTextContent('SELECT 1;');

    await user.click(within(consents).getByRole('button', { name: 'Revoke AI context for Dev' }));
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

  it('stays closed and explains itself while AI is off', async () => {
    await backend.aiSettingsSet({ ...DEFAULT_AI_SETTINGS, enabled: false });
    const { user } = await consoleWith('select 1');
    await user.keyboard('{Control>}{Alt>}a{/Alt}{/Control}');
    expect(screen.queryByRole('complementary', { name: 'AI assistant' })).toBeNull();
    expect(await screen.findByText(/AI is off/)).toBeVisible();
  });
});
