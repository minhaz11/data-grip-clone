import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../app/App';
import { useSettings } from '../../app/settingsStore';
import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import { DEFAULT_SETTINGS } from '../../ipc/types';

type User = ReturnType<typeof userEvent.setup>;

beforeEach(async () => {
  await backend.settingsSet({ ...DEFAULT_SETTINGS });
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
  useWorkspace.setState({ tabs: [], activeTabId: null });
});

async function openKeymap(user: User) {
  await user.keyboard('{Control>}{Alt>}s{/Alt}{/Control}');
  const dialog = screen.getByRole('dialog', { name: 'Settings' });
  await user.click(within(dialog).getByRole('tab', { name: 'Keymap' }));
  return dialog;
}

function row(dialog: HTMLElement, title: string) {
  const header = within(dialog).getByRole('rowheader', { name: new RegExp(`^${title}`) });
  const tr = header.closest('tr');
  if (!tr) {
    throw new Error(`no row for ${title}`);
  }
  return tr;
}

async function startApp() {
  const user = userEvent.setup();
  const view = render(<App />);
  await screen.findByRole('toolbar', { name: 'Main toolbar' });
  return { user, view };
}

describe('Settings > Keymap', () => {
  it('rebinds an action at once, keeps it after a restart, and the old chord stops working', async () => {
    const { user, view } = await startApp();
    const dialog = await openKeymap(user);
    const newConsole = row(dialog, 'New console');

    await user.click(
      within(newConsole).getByRole('button', { name: 'Add shortcut to New console' }),
    );
    await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}');
    expect(newConsole).toHaveTextContent('Ctrl+Alt+N');
    await user.click(
      within(newConsole).getByRole('button', { name: 'Remove Ctrl+Shift+Q from New console' }),
    );
    expect(newConsole).not.toHaveTextContent('Ctrl+Shift+Q');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await backend.settingsGet()).toMatchObject({
      keymap: { 'console.new': ['Ctrl+Alt+N'] },
    });

    // The new chord works immediately; the old one does nothing now.
    await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}');
    await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(1));
    await user.keyboard('{Control>}{Shift>}q{/Shift}{/Control}');
    expect(useWorkspace.getState().tabs).toHaveLength(1);
    // Tooltips follow the keymap.
    const toolbar = screen.getByRole('toolbar', { name: 'Main toolbar' });
    expect(within(toolbar).getByRole('button', { name: 'New console' })).toHaveAttribute(
      'title',
      'New console (Ctrl+Alt+N)',
    );

    // After a restart the saved keymap is loaded again.
    view.unmount();
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS } });
    await startApp();
    await waitFor(() =>
      expect(useSettings.getState().settings.keymap).toEqual({ 'console.new': ['Ctrl+Alt+N'] }),
    );
    await user.keyboard('{Control>}{Alt>}n{/Alt}{/Control}');
    await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(2));
  });

  it('shows conflicts before saving and blocks Save on a same-context clash', async () => {
    const { user } = await startApp();
    const dialog = await openKeymap(user);
    const stop = row(dialog, 'Stop the running query');
    await user.click(
      within(stop).getByRole('button', { name: 'Add shortcut to Stop the running query' }),
    );
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(stop).toHaveTextContent(
      'Ctrl+Enter is also bound to "Run statement or selection"; only one of them can run.',
    );
    expect(row(dialog, 'Run statement or selection')).toHaveTextContent(
      'also bound to "Stop the running query"',
    );
    expect(within(dialog).getByRole('alert')).toHaveTextContent('share a shortcut');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();

    // A context action hiding a global one is a warning, not an error.
    await user.click(within(stop).getByRole('button', { name: 'Reset Stop the running query' }));
    const copy = row(dialog, 'Copy selected cells');
    await user.click(
      within(copy).getByRole('button', { name: 'Add shortcut to Copy selected cells' }),
    );
    await user.keyboard('{Control>}w{/Control}');
    expect(copy).toHaveTextContent('Ctrl+W also runs "Close tab" everywhere else.');
    expect(row(dialog, 'Close tab')).toHaveTextContent(
      'Ctrl+W runs "Copy selected cells" instead while the result grid has focus.',
    );
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('refuses reserved chords and plain keys, and Escape cancels recording', async () => {
    const { user } = await startApp();
    const dialog = await openKeymap(user);
    const history = row(dialog, 'Query history');
    await user.click(
      within(history).getByRole('button', { name: 'Add shortcut to Query history' }),
    );
    await user.keyboard('q');
    expect(within(history).getByRole('alert')).toHaveTextContent('Add Ctrl or Alt');
    await user.keyboard('{Alt>}{F4}{/Alt}');
    expect(within(history).getByRole('alert')).toHaveTextContent('closes the window');
    await user.keyboard('{Escape}');
    // Escape ends recording without closing Settings or adding anything.
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(within(history).queryByRole('alert')).not.toBeInTheDocument();
    expect(history).toHaveTextContent('Ctrl+Alt+E');
    expect(within(history).queryByRole('button', { name: /Remove/ })).toBeInTheDocument();
    expect(within(history).getAllByRole('button', { name: /^Remove/ })).toHaveLength(1);
  });

  it('resets one action or all of them', async () => {
    const { user } = await startApp();
    const dialog = await openKeymap(user);
    const format = row(dialog, 'Format SQL');
    await user.click(
      within(format).getByRole('button', { name: 'Remove Ctrl+Alt+L from Format SQL' }),
    );
    const settingsRow = row(dialog, 'Settings');
    await user.click(
      within(settingsRow).getByRole('button', { name: 'Remove Ctrl+Alt+S from Settings' }),
    );
    expect(format).not.toHaveTextContent('Ctrl+Alt+L');

    await user.click(within(format).getByRole('button', { name: 'Reset Format SQL' }));
    expect(format).toHaveTextContent('Ctrl+Alt+L');
    expect(settingsRow).not.toHaveTextContent('Ctrl+Alt+S');

    await user.click(within(dialog).getByRole('button', { name: 'Reset all' }));
    expect(settingsRow).toHaveTextContent('Ctrl+Alt+S');
    expect(within(dialog).getByRole('button', { name: 'Reset all' })).toBeDisabled();
  });

  it('searches by title and by shortcut', async () => {
    const { user } = await startApp();
    const dialog = await openKeymap(user);
    await user.type(within(dialog).getByLabelText('Search actions'), 'ctrl+alt+e');
    const rows = within(dialog).getAllByRole('rowheader');
    expect(rows.map((r) => r.textContent)).toEqual(['Query history']);
  });

  it('runs editor actions only while the editor has focus', async () => {
    const { user } = await startApp();
    await user.keyboard('{Control>}{Shift>}q{/Shift}{/Control}');
    const editor = (await screen.findByRole('textbox', { name: /SQL$/ })) as HTMLTextAreaElement;
    editor.focus();
    await user.keyboard('select 1 from t');
    const text = () => {
      const tab = useWorkspace.getState().tabs[0];
      return isConsole(tab) ? tab.text : '';
    };

    // Focus outside the editor: the editor context's Format does not apply.
    screen.getByRole('button', { name: 'Settings' }).focus();
    await user.keyboard('{Control>}{Alt>}l{/Alt}{/Control}');
    expect(text()).toBe('select 1 from t');

    editor.focus();
    await user.keyboard('{Control>}{Alt>}l{/Alt}{/Control}');
    await waitFor(() => expect(text()).not.toBe('select 1 from t'));
    expect(text()).toMatch(/^select\s+1\s+from\s+t$/i);
  });
});
