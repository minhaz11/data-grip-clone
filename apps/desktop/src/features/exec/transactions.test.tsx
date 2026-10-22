import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { App } from '../../app/App';
import { useWorkspace } from '../../app/workspaceStore';
import { backend, type Backend } from '../../ipc/client';
import type {
  ConnectionDraft,
  ServerInfo,
  SessionKey,
  SessionState,
  TxStatus,
} from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { NEW_DRAFT } from '../connections/model';
import { useSessions } from '../connections/sessionsStore';
import { useExec } from './execStore';
import { disconnectSource } from './txGuards';
import { keyOf, useTx } from './txStore';

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
let quitListener: ((open: SessionKey[]) => void) | undefined;

beforeEach(async () => {
  for (const c of await backend.connectionsList()) await backend.connectionDelete(c.id);
  useConnections.setState({ items: [], selectedId: null, error: null });
  useSessions.setState({ byId: {} });
  useExec.setState({ runs: {}, view: {} });
  useTx.setState({ states: {} });
  vi.spyOn(backend, 'onConnectionStatus').mockResolvedValue(() => {});
  vi.spyOn(backend, 'connectionConnect').mockResolvedValue(INFO);
  vi.spyOn(backend, 'onQuitRequested').mockImplementation(async (cb) => {
    quitListener = cb;
    return () => {};
  });
  execute = vi.spyOn(backend, 'queryExecute').mockImplementation(async (_req, onEvent) => {
    queueMicrotask(() =>
      onEvent({ event: 'finished', status: 'completed', executed: 1, elapsedMs: 1 }),
    );
    return 'job-1';
  });
});
afterEach(() => vi.restoreAllMocks());

function state(session: SessionKey, status: TxStatus, mode: 'auto' | 'manual' = 'manual') {
  const s: SessionState = {
    session,
    open: true,
    status,
    settings: { mode, isolation: 'read_committed' },
  };
  return s;
}

/** A connected data source and a console bound to it, optionally with its own session. */
async function setup(
  text: string,
  draft: Partial<ConnectionDraft> = {},
  tab: { ownSession?: boolean; schema?: string } = {},
) {
  const user = userEvent.setup();
  const p = await backend.connectionCreate({ ...NEW_DRAFT, name: 'Dev', ...draft }, null);
  // The app reads live sessions at startup.
  vi.spyOn(backend, 'sessionsList').mockResolvedValue([{ id: p.id, info: INFO }]);
  render(<App />);
  await screen.findByRole('toolbar', { name: 'Main toolbar' });
  let id = '';
  await act(async () => {
    id = await useWorkspace.getState().newConsole(p.id);
    useWorkspace.getState().setSource(id, p.id);
    if (tab.ownSession) useWorkspace.getState().setOwnSession(id, true);
    if (tab.schema) useWorkspace.getState().setSchema(id, tab.schema);
  });
  const console = useWorkspace.getState().tabs.find((t) => t.id === id)?.console ?? '';
  const editor = (await screen.findByRole('textbox', { name: /SQL$/ })) as HTMLTextAreaElement;
  editor.focus();
  if (text) {
    await user.keyboard(text);
  }
  return { user, editor, profile: p, tabId: id, console };
}

describe('sessions and transactions in the UI', () => {
  it("sends the console's own session and schema with each run", async () => {
    const { user, profile, console } = await setup(
      'select 1',
      {},
      {
        ownSession: true,
        schema: 'shop',
      },
    );
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      session: { sourceId: profile.id, console },
      schema: 'shop',
    });
  });

  it('runs on the shared session without a schema by default', async () => {
    const { user, profile } = await setup('select 1');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const request = execute.mock.calls[0]?.[0];
    expect(request?.session).toEqual({ sourceId: profile.id });
    expect(request).not.toHaveProperty('schema');
  });

  it('blocks statements that would make a read-only source writable', async () => {
    const { user } = await setup('set default_transaction_read_only = off', { readOnly: true });
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByRole('alert')).toHaveTextContent('changes the read-only setting');
    expect(execute).not.toHaveBeenCalled();
  });

  it('still confirms production writes in Manual mode', async () => {
    const { user } = await setup("insert into audit values ('x')", {
      environment: 'production',
      txMode: 'manual',
      name: 'Billing',
    });
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(
      await screen.findByRole('dialog', { name: 'Modify production: Billing?' }),
    ).toBeInTheDocument();
    expect(execute).not.toHaveBeenCalled();
    await user.keyboard('{Escape}'); // dialogs are app-wide; leave none behind
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the open transaction and commits it from the console toolbar', async () => {
    const commit = vi.spyOn(backend, 'txCommit');
    vi.spyOn(backend, 'sessionState').mockImplementation(async (session) =>
      state(session, 'active'),
    );
    const { user, profile } = await setup('', { txMode: 'manual' });
    const toolbar = screen.getByRole('toolbar', { name: 'Console toolbar' });
    expect(await within(toolbar).findByRole('status')).toHaveTextContent('Transaction open');
    expect(screen.getByLabelText('transaction open')).toHaveTextContent('TX');
    commit.mockImplementation(async (session) => state(session, 'idle'));
    await user.click(within(toolbar).getByRole('button', { name: 'Commit' }));
    expect(commit).toHaveBeenCalledWith({ sourceId: profile.id });
    await waitFor(() => expect(within(toolbar).queryByRole('status')).not.toBeInTheDocument());
    expect(screen.queryByLabelText('transaction open')).not.toBeInTheDocument();
  });

  it('switches the transaction mode through the backend', async () => {
    const setTx = vi
      .spyOn(backend, 'sessionSetTx')
      .mockImplementation(async (session, settings) => ({
        session,
        open: true,
        status: 'idle',
        settings,
      }));
    const { user, profile } = await setup('');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Tx' }), 'manual');
    expect(setTx).toHaveBeenCalledWith(
      { sourceId: profile.id },
      { mode: 'manual', isolation: 'read_committed' },
    );
    expect(await screen.findByRole('combobox', { name: 'Isolation level' })).toBeInTheDocument();
  });

  it('asks before closing a console whose own session has an open transaction', async () => {
    const rollback = vi
      .spyOn(backend, 'txRollback')
      .mockImplementation(async (session) => state(session, 'idle'));
    const close = vi.spyOn(backend, 'sessionClose').mockResolvedValue(null);
    const { user, profile, tabId, console } = await setup('', {}, { ownSession: true });
    const own = { sourceId: profile.id, console };
    act(() => useTx.setState({ states: { [keyOf(own)]: state(own, 'active') } }));

    await user.keyboard('{Control>}w{/Control}');
    let dialog = await screen.findByRole('dialog', { name: `Close ${console}?` });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Enter}'); // Enter on the focused Cancel keeps everything
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useWorkspace.getState().tabs.some((t) => t.id === tabId)).toBe(true);
    expect(rollback).not.toHaveBeenCalled();

    (screen.getByRole('textbox', { name: /SQL$/ }) as HTMLTextAreaElement).focus();
    await user.keyboard('{Control>}w{/Control}');
    dialog = await screen.findByRole('dialog', { name: `Close ${console}?` });
    await user.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await waitFor(() =>
      expect(useWorkspace.getState().tabs.some((t) => t.id === tabId)).toBe(false),
    );
    expect(rollback).toHaveBeenCalledWith(own);
    expect(close).toHaveBeenCalledWith(own);
  });

  it('closes a console on the shared session without asking', async () => {
    const { user, profile, tabId } = await setup('');
    const shared = { sourceId: profile.id };
    act(() => useTx.setState({ states: { [keyOf(shared)]: state(shared, 'active') } }));
    await user.keyboard('{Control>}w{/Control}');
    await waitFor(() =>
      expect(useWorkspace.getState().tabs.some((t) => t.id === tabId)).toBe(false),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('resolves open transactions before disconnecting, and keeps the dialog on a failed commit', async () => {
    const commit = vi
      .spyOn(backend, 'txCommit')
      .mockRejectedValueOnce({ kind: 'db', message: 'serialization failure' })
      .mockImplementation(async (session) => state(session, 'idle'));
    const disconnect = vi.spyOn(backend, 'connectionDisconnect').mockResolvedValue(null);
    const { user, profile } = await setup('');
    const shared = { sourceId: profile.id };
    act(() => useTx.setState({ states: { [keyOf(shared)]: state(shared, 'active') } }));

    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = disconnectSource(profile.id);
    });
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect?' });
    expect(dialog).toHaveTextContent('Dev, shared session');
    await user.click(within(dialog).getByRole('button', { name: 'Commit' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('serialization failure');
    expect(disconnect).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Commit' }));
    expect(await done).toBe(true);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledWith(profile.id);
  });

  it('answers a quit request with the chosen resolution', async () => {
    const quit = vi.spyOn(backend, 'appQuit').mockResolvedValue(null);
    const { user, profile } = await setup('');
    await waitFor(() => expect(quitListener).toBeDefined());
    act(() => quitListener?.([{ sourceId: profile.id }]));
    const dialog = await screen.findByRole('dialog', { name: 'Quit with open transactions?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Roll back and quit' }));
    expect(quit).toHaveBeenCalledWith('rollback');
  });
});
