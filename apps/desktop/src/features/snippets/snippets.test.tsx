import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { resetHydrationForTests, useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import { activeSnippets, useSnippets } from './snippetsStore';

beforeEach(async () => {
  for (const s of await backend.snippetsList()) {
    await backend.snippetDelete(s.id);
  }
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
  useSnippets.setState({ user: [] });
  vi.spyOn(backend, 'onConnectionStatus').mockResolvedValue(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function openConsole() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('toolbar', { name: 'Main toolbar' });
  await act(async () => void (await useWorkspace.getState().newConsole(null)));
  const editor = (await screen.findByRole('textbox', { name: /SQL$/ })) as HTMLTextAreaElement;
  editor.focus();
  return { user, editor };
}

describe('snippets', () => {
  it('expands a built-in on Tab and selects its first tab stop', async () => {
    const { user, editor } = await openConsole();
    await user.keyboard('sel{Tab}');
    await waitFor(() => expect(editor.value).toBe('SELECT *\nFROM table_name\nWHERE true;'));
    await waitFor(() =>
      expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe('*'),
    );
    expect(editor).toHaveFocus();
  });

  it('leaves Tab alone after a word that is not an abbreviation', async () => {
    const { user, editor } = await openConsole();
    const expand = vi.fn();
    await user.keyboard('selectx');
    await user.keyboard('{Tab}');
    expect(editor.value).toBe('selectx');
    expect(expand).not.toHaveBeenCalled();
  });

  it('a snippet created in Settings expands at once, and replaces a built-in', async () => {
    const { user, editor } = await openConsole();
    await user.keyboard('{Control>}{Alt>}s{/Alt}{/Control}');
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    await user.click(within(dialog).getByRole('tab', { name: 'Snippets' }));
    await user.click(within(dialog).getByRole('button', { name: 'New' }));
    await user.type(within(dialog).getByLabelText('Abbreviation'), 'pgfn');
    await user.type(within(dialog).getByLabelText('Description'), 'function stub');
    const template = within(dialog).getByLabelText('Template');
    await user.click(template);
    await user.paste('select \\$1 as ${1:value}, \\$\\$x\\$\\$$0');
    expect(within(dialog).getByLabelText('Expanded text')).toHaveTextContent(
      'select $1 as value, $$x$$',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save Snippet' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Saved');
    // Customizing a built-in shadows it.
    await user.click(within(dialog).getByRole('button', { name: 'sel, built-in' }));
    await user.click(within(dialog).getByRole('button', { name: /Customize/ }));
    const body = within(dialog).getByLabelText('Template');
    await user.clear(body);
    await user.click(body);
    await user.paste('SELECT 42$0');
    await user.click(within(dialog).getByRole('button', { name: 'Save Snippet' }));
    await waitFor(() =>
      expect(activeSnippets().find((s) => s.abbreviation === 'sel')?.body).toBe('SELECT 42$0'),
    );
    await user.keyboard('{Escape}');

    editor.focus();
    await user.keyboard('pgfn{Tab}');
    await waitFor(() => expect(editor.value).toBe('select $1 as value, $$x$$'));
    // The first tab stop is selected once the new text has rendered.
    await waitFor(() =>
      expect(editor.value.slice(editor.selectionStart, editor.selectionEnd)).toBe('value'),
    );
    editor.setSelectionRange(editor.value.length, editor.value.length);
    await user.keyboard(' sel{Tab}');
    await waitFor(() => expect(editor.value).toBe('select $1 as value, $$x$$ SELECT 42'));
  });
});
