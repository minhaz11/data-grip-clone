import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { App } from '../../app/App';
import { useSettings } from '../../app/settingsStore';
import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { backend, type Backend } from '../../ipc/client';
import {
  DEFAULT_SETTINGS,
  type ConnectionDraft,
  type ExecEvent,
  type ExecRequest,
  type ServerInfo,
} from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { NEW_DRAFT } from '../connections/model';
import { useSessions } from '../connections/sessionsStore';
import { useExec } from './execStore';
import { useNotifications } from '../notifications/notifications';
import { pickStatements, planRun } from './runQuery';

const INFO: ServerInfo = {
  version: 'PostgreSQL 16.15',
  serverVersion: '16.15',
  database: 'quarry_test',
  user: 'quarry',
  tls: false,
  readOnly: false,
  latencyMs: 3,
};

describe('pickStatements', () => {
  const text = 'select 1;\nselect 2;\nselect 3';
  it('uses the selection, else the statement at the caret, else the whole script', () => {
    expect(pickStatements(text, { start: 10, end: 28 }, 0, 'current')).toEqual([
      { sql: 'select 2', offset: 10 },
      { sql: 'select 3', offset: 20 },
    ]);
    expect(pickStatements(text, { start: 12, end: 12 }, 12, 'current')).toEqual([
      { sql: 'select 2', offset: 10 },
    ]);
    expect(pickStatements(text, { start: 0, end: 0 }, 0, 'script').map((s) => s.offset)).toEqual([
      0, 10, 20,
    ]);
    expect(pickStatements('   ', { start: 0, end: 0 }, 1, 'current')).toEqual([]);
  });
});

type Responder = (req: ExecRequest, emit: (e: ExecEvent) => void) => void;

let execute: MockInstance<Backend['queryExecute']>;
function respondWith(responder: Responder) {
  execute.mockImplementation(async (req, onEvent) => {
    queueMicrotask(() => responder(req, onEvent));
    return 'job-1';
  });
}

beforeEach(async () => {
  for (const c of await backend.connectionsList()) await backend.connectionDelete(c.id);
  useConnections.setState({ items: [], selectedId: null, error: null });
  useSessions.setState({ byId: {} });
  useExec.setState({ runs: {}, view: {} });
  vi.spyOn(backend, 'onConnectionStatus').mockResolvedValue(() => {});
  vi.spyOn(backend, 'connectionConnect').mockResolvedValue(INFO);
  execute = vi.spyOn(backend, 'queryExecute');
});
afterEach(() => vi.restoreAllMocks());

/** Opens the app with one console bound to a fresh data source and `text` typed in it. */
async function setup(text: string, draft: Partial<ConnectionDraft> = {}) {
  const user = userEvent.setup();
  const p = await backend.connectionCreate({ ...NEW_DRAFT, name: 'Dev', ...draft }, null);
  render(<App />);
  await screen.findByRole('toolbar', { name: 'Main toolbar' });
  await act(async () => {
    const id = await useWorkspace.getState().newConsole(p.id);
    useWorkspace.getState().setSource(id, p.id);
  });
  const editor = (await screen.findByRole('textbox', { name: /SQL$/ })) as HTMLTextAreaElement;
  editor.focus();
  await user.keyboard(text.replace(/[{[]/g, (c) => c + c));
  return { user, editor, profile: p };
}

const statementsSent = () => execute.mock.calls.map(([req]) => req.statements);

describe('running queries', () => {
  it('runs the statement under the caret and shows its result set', async () => {
    respondWith((req, emit) => {
      emit({ event: 'statementStarted', index: 0, offset: req.statements[0]?.offset ?? 0 });
      emit({
        event: 'statementDone',
        index: 0,
        offset: req.statements[0]?.offset ?? 0,
        elapsedMs: 4,
        outcome: {
          type: 'rows',
          columns: [
            { name: 'id', typeName: 'int4' },
            { name: 'email', typeName: 'text' },
          ],
          rows: [
            ['1', 'a@x.test'],
            ['2', null],
          ],
          totalRows: 2,
          truncated: false,
        },
      });
      emit({ event: 'finished', status: 'completed', executed: 1, elapsedMs: 6 });
    });
    const { user, editor } = await setup('select 0;\nselect id, email from users;');
    editor.setSelectionRange(15, 15); // inside the second statement
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() =>
      expect(statementsSent()).toEqual([[{ sql: 'select id, email from users', offset: 10 }]]),
    );
    const grid = await screen.findByRole('grid', { name: 'Result rows' });
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['idint4', 'emailtext']);
    expect(grid).toHaveAttribute('aria-rowcount', '3'); // header + 2 rows
    expect(within(grid).getByText('NULL')).toBeInTheDocument();
    expect(screen.getByText('2 rows')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Result 1' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Output' }));
    expect(screen.getByLabelText('Statement output')).toHaveTextContent('2 rows');
  });

  it('marks the error position in the editor and links to it from the output', async () => {
    respondWith((req, emit) => {
      emit({ event: 'statementStarted', index: 0, offset: 0 });
      emit({
        event: 'statementFailed',
        index: 0,
        offset: req.statements[0]?.offset ?? 0,
        elapsedMs: 2,
        error: {
          message: 'column "emial" does not exist',
          detail: null,
          sqlstate: '42703',
          position: 13,
          hint: 'Perhaps you meant "email".',
          cancelled: false,
          connectionLost: false,
        },
      });
      emit({ event: 'finished', status: 'failed', executed: 1, elapsedMs: 3 });
    });
    const { user, editor } = await setup('select id,\n emial from users');
    await user.keyboard('{Control>}{Enter}{/Control}');

    const output = await screen.findByLabelText('Statement output');
    await waitFor(() => expect(output).toHaveTextContent('column "emial" does not exist'));
    expect(output).toHaveTextContent('SQLSTATE 42703');
    expect(output).toHaveTextContent('Hint: Perhaps you meant "email".');
    expect(editor).toHaveAttribute('data-error', '12-17'); // "emial"
    await user.click(within(output).getByRole('button', { name: 'line 2, column 2' }));
    expect(editor.selectionStart).toBe(12);
  });

  it('blocks writes on read-only data sources before anything is sent', async () => {
    const { user } = await setup('delete from users where id = 1', { readOnly: true });
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByRole('alert')).toHaveTextContent('"Dev" is read-only');
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks before destructive statements and runs only on confirmation', async () => {
    respondWith((_req, emit) =>
      emit({ event: 'finished', status: 'completed', executed: 1, elapsedMs: 1 }),
    );
    const { user } = await setup('delete from users');
    await user.keyboard('{Control>}{Enter}{/Control}');
    let dialog = await screen.findByRole('dialog', { name: 'Run destructive statement?' });
    expect(dialog).toHaveTextContent('DELETE without WHERE affects every row');
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(execute).not.toHaveBeenCalled();

    (screen.getByRole('textbox', { name: /SQL$/ }) as HTMLTextAreaElement).focus();
    await user.keyboard('{Control>}{Enter}{/Control}');
    dialog = await screen.findByRole('dialog', { name: 'Run destructive statement?' });
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  });

  it('asks before modifying a production data source, naming it', async () => {
    respondWith((_req, emit) =>
      emit({ event: 'finished', status: 'completed', executed: 1, elapsedMs: 1 }),
    );
    const { user } = await setup("insert into audit values ('x')", {
      environment: 'production',
      name: 'Billing',
    });
    await user.keyboard('{Control>}{Enter}{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Modify production: Billing?' });
    expect(dialog).toHaveTextContent('Billing is a production data source');
    expect(execute).not.toHaveBeenCalled();
    await user.keyboard('{Escape}'); // dismissing never runs it
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not ask for read-only statements on production', async () => {
    respondWith((_req, emit) =>
      emit({ event: 'finished', status: 'completed', executed: 1, elapsedMs: 1 }),
    );
    const { user } = await setup('select 1', { environment: 'production' });
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stops a running job with Ctrl+F2', async () => {
    const cancel = vi.spyOn(backend, 'queryCancel').mockResolvedValue(null);
    respondWith((_req, emit) => emit({ event: 'statementStarted', index: 0, offset: 0 }));
    const { user } = await setup('select pg_sleep(30)');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await screen.findByText(/Running on Dev/);
    expect(screen.getByRole('button', { name: /Stop/ })).toBeEnabled();
    await user.keyboard('{Control>}{F2}{/Control}');
    expect(cancel).toHaveBeenCalledWith('job-1');
  });

  it('explains when the console has no data source', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('toolbar', { name: 'Main toolbar' });
    await act(async () => void (await useWorkspace.getState().newConsole(null)));
    const editor = await screen.findByRole('textbox', { name: /SQL$/ });
    (editor as HTMLTextAreaElement).focus();
    await user.keyboard('select 1{Control>}{Enter}{/Control}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose a data source for this console',
    );
    expect(execute).not.toHaveBeenCalled();
  });
});

const done = (index: number, offset: number): ExecEvent => ({
  event: 'statementDone',
  index,
  offset,
  elapsedMs: 2,
  outcome: { type: 'command', rowsAffected: 1 },
});
const finished = (elapsedMs = 3): ExecEvent => ({
  event: 'finished',
  status: 'completed',
  executed: 1,
  elapsedMs,
});

describe('run target policy', () => {
  const text = 'select 1;\n\nselect 2;\nselect 3';
  it('runs a multi-statement selection or asks, per the setting', () => {
    const all = planRun(text, { start: 0, end: text.length }, 0, 'current', {
      runOutsideStatement: 'nearest',
      runSelection: 'all',
    });
    expect(all.statements).toHaveLength(3);
    expect(all.ask).toBeUndefined();
    const ask = planRun(text, { start: 0, end: text.length }, 0, 'current', {
      runOutsideStatement: 'nearest',
      runSelection: 'ask',
    });
    expect(ask.ask).toMatchObject({ allowAll: true });
    expect(ask.ask?.options).toHaveLength(3);
  });

  it('runs the nearest statement or asks when the caret is between statements', () => {
    const blank = text.indexOf('\n\n') + 1; // the empty line after "select 1;"
    // Right after the ";" still belongs to statement 1; the blank line below does not.
    expect(
      planRun(text, { start: blank, end: blank }, blank, 'current', {
        runOutsideStatement: 'nearest',
        runSelection: 'all',
      }).statements.map((s) => s.sql),
    ).toEqual(['select 1']);
    const ask = planRun(text, { start: blank, end: blank }, blank, 'current', {
      runOutsideStatement: 'ask',
      runSelection: 'all',
    });
    expect(ask.ask).toMatchObject({ allowAll: false });
    expect(ask.ask?.options.map((s) => s.sql)).toEqual(['select 1', 'select 2', 'select 3']);
    // Inside a statement nothing is asked.
    expect(
      planRun(text, { start: 2, end: 2 }, 2, 'current', {
        runOutsideStatement: 'ask',
        runSelection: 'ask',
      }).ask,
    ).toBeUndefined();
  });
});

describe('editor features', () => {
  beforeEach(async () => {
    await useSettings.getState().update(DEFAULT_SETTINGS);
    useNotifications.setState({ items: [] });
  });

  /** Settings go through the backend: the app loads them again when it renders. */
  const settings = (patch: Partial<typeof DEFAULT_SETTINGS>) =>
    useSettings.getState().update({ ...DEFAULT_SETTINGS, ...patch });

  it('prompts for :id once, binds the value and remembers it', async () => {
    respondWith((req, emit) => {
      emit(done(0, req.statements[0]?.offset ?? 0));
      emit(finished());
    });
    const { user, editor } = await setup('select * from users where id = :id and a = :id');
    await user.keyboard('{Control>}{Enter}{/Control}');
    const dialog = await screen.findByRole('dialog', { name: 'Statement parameters' });
    expect(within(dialog).getAllByRole('textbox')).toHaveLength(1); // one prompt per name
    await user.type(within(dialog).getByLabelText(':id'), "7' or 1=1");
    await user.click(within(dialog).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(statementsSent()).toEqual([
      [
        {
          sql: 'select * from users where id = $1  and a = $1 ',
          offset: 0,
          params: ["7' or 1=1"],
        },
      ],
    ]);
    const ws = useWorkspace.getState();
    const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
    expect(isConsole(tab) && tab.params).toEqual({ id: "7' or 1=1" });
    // The output shows the statement as written, with its values.
    await user.click(screen.getByRole('tab', { name: 'Output' }));
    const output = screen.getByLabelText('Statement output');
    expect(output).toHaveTextContent('where id = :id');
    expect(output).toHaveTextContent(`Parameters: :id = '7' or 1=1'`);

    // Next time the remembered value is offered; NULL sends SQL NULL.
    editor.focus();
    await user.keyboard('{Control>}{Enter}{/Control}');
    const again = await screen.findByRole('dialog', { name: 'Statement parameters' });
    expect(within(again).getByLabelText(':id')).toHaveValue("7' or 1=1");
    await user.click(within(again).getByLabelText(':id is NULL'));
    await user.click(within(again).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(statementsSent()[1]?.[0]?.params).toEqual([null]);
  });

  it('cancelling the prompt runs nothing', async () => {
    const { user } = await setup('select :x');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await screen.findByRole('dialog', { name: 'Statement parameters' });
    await user.keyboard('{Escape}');
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks which statements to run from a selection when set to', async () => {
    await settings({ runSelection: 'ask' });
    respondWith((req, emit) => {
      emit(done(0, req.statements[0]?.offset ?? 0));
      emit(finished());
    });
    const { user, editor } = await setup('select 1;\nselect 2;');
    editor.setSelectionRange(0, editor.value.length);
    await user.keyboard('{Control>}{Enter}{/Control}');
    const chooser = await screen.findByRole('dialog', { name: 'Run which statements?' });
    await user.click(within(chooser).getByRole('button', { name: 'select 2' }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    expect(statementsSent()).toEqual([[{ sql: 'select 2', offset: 10 }]]);
  });

  it('shows notices in the output of the console that ran the statement', async () => {
    respondWith((req, emit) => {
      emit({ event: 'statementStarted', index: 0, offset: 0 });
      emit({
        event: 'notice',
        index: 0,
        notice: {
          severity: 'NOTICE',
          message: 'hello from plpgsql',
          detail: null,
          hint: 'a hint',
          sqlstate: '00000',
        },
      });
      emit(done(0, req.statements[0]?.offset ?? 0));
      emit(finished());
    });
    const { user, profile } = await setup("do $$ begin raise notice 'hello'; end $$");
    await user.keyboard('{Control>}{Enter}{/Control}');
    const output = await screen.findByLabelText('Statement output');
    await waitFor(() =>
      expect(output).toHaveTextContent('NOTICE: hello from plpgsql Hint: a hint'),
    );
    // Another console has its own (empty) output.
    await act(async () => {
      const id = await useWorkspace.getState().newConsole(profile.id);
      useWorkspace.getState().setSource(id, profile.id);
    });
    expect(screen.queryByText(/hello from plpgsql/)).not.toBeInTheDocument();
  });

  it('keeps earlier runs in the output, searchable and clearable', async () => {
    respondWith((req, emit) => {
      emit(done(0, req.statements[0]?.offset ?? 0));
      emit(finished());
    });
    const { user, editor } = await setup('select 1;\nselect 22;');
    editor.setSelectionRange(1, 1);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    editor.setSelectionRange(12, 12);
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    const output = screen.getByLabelText('Statement output');
    await waitFor(() => expect(within(output).getAllByText(/^select \d+$/)).toHaveLength(2));
    expect(output).toHaveTextContent('auto-commit');

    // Focus, then type: in jsdom the panel resize handle would take a click.
    screen.getByLabelText('Search output').focus();
    await user.keyboard('22');
    expect(
      within(output)
        .getAllByText(/^select \d+$/)
        .map((e) => e.textContent),
    ).toEqual(['select 22']);
    await user.keyboard('{Backspace}{Backspace}');
    await user.click(screen.getByRole('button', { name: 'Clear output' }));
    expect(within(output).queryAllByText(/^select \d+$/)).toHaveLength(0);
  });

  it('notifies when a query ran longer than the long-query threshold', async () => {
    await settings({ longQuerySecs: 1 });
    respondWith((req, emit) => {
      emit(done(0, req.statements[0]?.offset ?? 0));
      emit(finished(65_000));
    });
    const { user } = await setup('select pg_sleep(65)');
    await user.keyboard('{Control>}{Enter}{/Control}');
    const toasts = await screen.findByRole('status', { name: 'Notifications' });
    await waitFor(() => expect(toasts).toHaveTextContent('Query on Dev finished after 1 min 5 s.'));
    expect(screen.getByRole('button', { name: 'Notifications (1)' })).toBeInTheDocument();
  });

  it('jumps to the error with F8 and Shift+F8', async () => {
    respondWith((req, emit) => {
      emit({
        event: 'statementFailed',
        index: 0,
        offset: req.statements[0]?.offset ?? 0,
        elapsedMs: 1,
        error: {
          message: 'syntax error at or near "form"',
          detail: null,
          hint: null,
          sqlstate: '42601',
          position: 10,
          cancelled: false,
          connectionLost: false,
        },
      });
      emit({ event: 'finished', status: 'failed', executed: 1, elapsedMs: 1 });
    });
    const { user, editor } = await setup('select 1 form t');
    await user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(editor).toHaveAttribute('data-error', '9-13'));
    expect(editor).toHaveAttribute('title', 'syntax error at or near "form"');
    editor.setSelectionRange(0, 0);
    await user.keyboard('{F8}');
    expect(editor.selectionStart).toBe(9);
    editor.setSelectionRange(15, 15);
    await user.keyboard('{Shift>}{F8}{/Shift}');
    expect(editor.selectionStart).toBe(9);
  });
});
