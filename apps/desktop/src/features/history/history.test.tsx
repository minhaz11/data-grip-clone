import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { App } from '../../app/App';
import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { backend, type Backend } from '../../ipc/client';
import type { ConnectionProfile, HistoryEntry } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { NEW_DRAFT } from '../connections/model';

let search: MockInstance<Backend['historySearch']>;
let source: ConnectionProfile;

function entry(id: number, sql: string, patch: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    connectionId: source.id,
    console: null,
    sql,
    startedAt: Date.UTC(2026, 9, 23, 8, 0, id),
    durationMs: 12,
    status: 'ok',
    rowCount: 1,
    error: null,
    txMode: 'auto',
    ...patch,
  };
}

beforeEach(async () => {
  for (const c of await backend.connectionsList()) {
    await backend.connectionDelete(c.id);
  }
  useConnections.setState({ items: [], selectedId: null, error: null });
  useWorkspace.setState({ tabs: [], activeTabId: null });
  source = await backend.connectionCreate({ ...NEW_DRAFT, name: 'Shop' }, null);
  search = vi.spyOn(backend, 'historySearch').mockImplementation(async (query) => {
    const all = [
      entry(3, 'select * from orders', { status: 'cancelled', rowCount: null, error: 'cancelled' }),
      entry(2, 'select nope', { status: 'error', rowCount: null, error: 'column "nope"' }),
      entry(1, 'select * from customers\nwhere id = 1'),
    ];
    return all.filter((e) => e.sql.includes(query.text.trim()));
  });
});
afterEach(() => vi.restoreAllMocks());

function nth(elements: HTMLElement[], index: number): HTMLElement {
  const element = elements[index];
  if (!element) {
    throw new Error(`no element at ${index}`);
  }
  return element;
}

/** The entries list (the data source `<select>` has options too). */
function rows(dialog: HTMLElement) {
  return within(within(dialog).getByRole('listbox', { name: 'History entries' })).getAllByRole(
    'option',
  );
}

async function openHistory(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Control>}{Alt>}e{/Alt}{/Control}');
  const dialog = await screen.findByRole('dialog', { name: 'Query History' });
  await within(dialog).findByText('select nope');
  return dialog;
}

async function renderWithConsole(text: string) {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('toolbar', { name: 'Main toolbar' });
  let id = '';
  await act(async () => {
    id = await useWorkspace.getState().newConsole(source.id);
    useWorkspace.getState().updateText(id, text);
  });
  const editor = (await screen.findByRole('textbox', { name: /SQL$/ })) as HTMLTextAreaElement;
  editor.focus();
  editor.setSelectionRange(text.length, text.length);
  return { user, id, editor };
}

describe('query history popup', () => {
  it('lists entries with status and data source, and searches as you type', async () => {
    const { user } = await renderWithConsole('');
    const dialog = await openHistory(user);

    const options = rows(dialog);
    expect(options).toHaveLength(3);
    expect(within(nth(options, 0)).getByRole('img', { name: 'Cancelled' })).toBeInTheDocument();
    expect(within(nth(options, 1)).getByRole('img', { name: 'Failed' })).toBeInTheDocument();
    expect(within(nth(options, 2)).getByRole('img', { name: 'Succeeded' })).toBeInTheDocument();
    expect(options[2]).toHaveTextContent('select * from customers');
    expect(options[2]).toHaveTextContent('Shop');
    // The console's data source is the default filter.
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectionId: source.id, text: '', offset: 0 }),
    );

    await user.type(within(dialog).getByLabelText('Search history'), 'orders');
    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'orders' })),
    );
    await waitFor(() => expect(rows(dialog)).toHaveLength(1));

    await user.selectOptions(within(dialog).getByLabelText('Data source'), '');
    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith(
        expect.objectContaining({ connectionId: undefined, text: 'orders' }),
      ),
    );
  });

  it('inserts the selected statement at the caret', async () => {
    const { user, id } = await renderWithConsole('-- start\n');
    const dialog = await openHistory(user);
    // Arrow keys move the selection from the search box; Enter inserts.
    await user.keyboard('{ArrowDown}');
    expect(rows(dialog)[1]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');

    expect(screen.queryByRole('dialog', { name: 'Query History' })).not.toBeInTheDocument();
    await waitFor(() => {
      const tab = useWorkspace.getState().tabs.find((t) => t.id === id);
      expect(isConsole(tab) && tab.text).toBe('-- start\nselect nope');
    });
  });

  it('opens the selected statement in a new console of its data source', async () => {
    const { user, id } = await renderWithConsole('');
    const dialog = await openHistory(user);
    await user.click(nth(rows(dialog), 2));
    await user.click(within(dialog).getByRole('button', { name: 'Open in new console' }));

    await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(2));
    const opened = useWorkspace.getState().tabs.find((t) => t.id !== id);
    expect(isConsole(opened) && opened.sourceId).toBe(source.id);
    expect(isConsole(opened) && opened.text).toBe('select * from customers\nwhere id = 1');
    expect(useWorkspace.getState().activeTabId).toBe(opened?.id);
  });

  it('deletes an entry only after confirmation', async () => {
    const remove = vi.spyOn(backend, 'historyDelete').mockResolvedValue(1);
    const { user } = await renderWithConsole('');
    const dialog = await openHistory(user);

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete history entry' });
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(remove).not.toHaveBeenCalled();
    expect(rows(dialog)).toHaveLength(3);

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    const again = await screen.findByRole('dialog', { name: 'Delete history entry' });
    await user.click(within(again).getByRole('button', { name: 'Delete' }));
    expect(remove).toHaveBeenCalledWith([3]);
    await waitFor(() => expect(rows(dialog)).toHaveLength(2));
  });

  it('clears a data source history only after confirmation', async () => {
    const clear = vi.spyOn(backend, 'historyClear').mockResolvedValue(3);
    const { user } = await renderWithConsole('');
    const dialog = await openHistory(user);

    await user.click(within(dialog).getByRole('button', { name: 'Clear data source history' }));
    const confirm = await screen.findByRole('dialog', { name: 'Clear query history' });
    expect(confirm).toHaveTextContent('Shop');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(clear).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Clear data source history' }));
    const again = await screen.findByRole('dialog', { name: 'Clear query history' });
    await user.click(within(again).getByRole('button', { name: 'Clear history' }));
    expect(clear).toHaveBeenCalledWith(source.id);

    // Clearing needs one data source: with "All" chosen the button is disabled.
    await user.selectOptions(within(dialog).getByLabelText('Data source'), '');
    expect(
      within(dialog).getByRole('button', { name: 'Clear data source history' }),
    ).toBeDisabled();
  });

  it('exports the current search', async () => {
    const save = vi.spyOn(backend, 'historyExport').mockResolvedValue('/tmp/query-history.csv');
    const { user } = await renderWithConsole('');
    const dialog = await openHistory(user);
    await user.click(within(dialog).getByRole('button', { name: 'Export CSV' }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: source.id, text: '' }),
      'csv',
    );
    expect(await screen.findByText(/Query history saved to/)).toBeInTheDocument();
  });

  it('cannot insert without an open console but can open a new one', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('toolbar', { name: 'Main toolbar' });
    await user.click(screen.getByRole('button', { name: /Query history/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Query History' });
    await within(dialog).findByText('select nope');
    expect(within(dialog).getByRole('button', { name: 'Insert' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Open in new console' })).toBeEnabled();
  });
});

describe('history settings', () => {
  it('saves the per-data-source flag from the connection dialog', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(backend, 'connectionCreate');
    render(<App />);
    await screen.findByRole('toolbar', { name: 'Main toolbar' });
    await user.keyboard('{Alt>}{Insert}{/Alt}');
    const dialog = screen.getByRole('dialog', { name: 'New PostgreSQL Data Source' });
    const flag = within(dialog).getByLabelText('Record query history');
    expect(flag).toBeChecked();
    expect(flag).toHaveAccessibleDescription(/including any values written in them/);
    await user.type(within(dialog).getByLabelText('Name'), 'Secrets');
    await user.click(flag);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Secrets', historyEnabled: false }),
      null,
    );
  });

  it('validates and saves retention in Settings', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(backend, 'settingsSet');
    render(<App />);
    await screen.findByRole('toolbar', { name: 'Main toolbar' });
    await user.keyboard('{Control>}{Alt>}s{/Alt}{/Control}');
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const limit = within(dialog).getByLabelText('Query history per data source');
    await user.clear(limit);
    await user.type(limit, '50');
    expect(limit).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(limit);
    await user.type(limit, '500');
    const age = within(dialog).getByLabelText('Remove history older than');
    await user.clear(age);
    await user.type(age, '30');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ historyLimit: 500, historyMaxAgeDays: 30 }),
    );
  });
});
