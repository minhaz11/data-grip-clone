import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { backend } from '../ipc/client';
import { App } from './App';

describe('App workbench', () => {
  it('opens, edits, and closes consoles via keyboard and persists the workspace', async () => {
    const user = userEvent.setup();
    const save = vi.spyOn(backend, 'workspaceSet');
    const write = vi.spyOn(backend, 'consoleWrite');
    render(<App />);

    expect(await screen.findByText('No open consoles.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Database Explorer' })).toHaveTextContent(
      'No data sources configured.',
    );

    await user.keyboard('{Control>}{Shift>}q{/Shift}{/Control}');
    await user.keyboard('{Control>}{Shift>}q{/Shift}{/Control}');
    const tabs = within(screen.getByRole('tablist', { name: 'Open consoles' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['console.sql', 'console_1.sql']);
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');

    const editor = await screen.findByRole('textbox', { name: 'console_1 SQL' });
    // jsdom reports 0x0 rects, so the panel library treats every pointerdown as a separator hit and
    // blocks focus-on-click; focus directly (real click-to-focus is covered in the browser E2E).
    editor.focus();
    await user.keyboard('select 1;');
    expect(screen.getByLabelText('Cursor position')).toHaveTextContent('Ln 1, Col 10');

    // Text autosaves to the console's .sql file; the workspace snapshot only names the console.
    await waitFor(() => expect(write).toHaveBeenLastCalledWith('console_1', 'select 1;'));
    await waitFor(() =>
      expect(save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tabs: expect.arrayContaining([expect.objectContaining({ console: 'console_1' })]),
        }),
      ),
    );
    expect(JSON.stringify(save.mock.lastCall)).not.toContain('select 1;');

    await user.keyboard('{Control>}w{/Control}');
    expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(1);
  });

  it('changes and persists the theme through the settings dialog', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('toolbar', { name: 'Main toolbar' });

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    await user.selectOptions(within(dialog).getByLabelText('Theme'), 'dark');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(await backend.settingsGet()).toMatchObject({ theme: 'dark' });
  });

  it('rejects an out-of-range editor font size', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('toolbar', { name: 'Main toolbar' });
    await user.keyboard('{Control>}{Alt>}s{/Alt}{/Control}');
    const input = within(screen.getByRole('dialog')).getByLabelText('Editor font size');
    await user.clear(input);
    await user.type(input, '99');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
