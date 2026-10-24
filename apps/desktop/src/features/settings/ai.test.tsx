import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { backend } from '../../ipc/client';
import { DEFAULT_AI_SETTINGS, type AiStreamEvent } from '../../ipc/types';
import { aiAvailable, useAi } from '../ai/aiStore';

const KEY = 'sk-ant-api03-ui-Canary-0042';

beforeEach(async () => {
  await backend.aiKeyClear();
  await backend.aiSettingsSet(structuredClone(DEFAULT_AI_SETTINGS));
  await useAi.getState().load();
  vi.spyOn(backend, 'onConnectionStatus').mockResolvedValue(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function openAi() {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('toolbar', { name: 'Main toolbar' });
  await user.keyboard('{Control>}{Alt>}s{/Alt}{/Control}');
  const dialog = screen.getByRole('dialog', { name: 'Settings' });
  await user.click(within(dialog).getByRole('tab', { name: 'AI' }));
  return { user, dialog };
}

describe('Settings > AI', () => {
  it('says where data goes and starts switched off', async () => {
    const { dialog } = await openAi();
    expect(within(dialog).getByRole('heading', { name: 'Where your data goes' })).toBeVisible();
    expect(dialog).toHaveTextContent(/directly from this computer to Anthropic/);
    expect(within(dialog).getByRole('checkbox', { name: 'Enable AI features' })).not.toBeChecked();
    expect(within(dialog).getByRole('button', { name: 'Test' })).toBeDisabled();
    expect(within(dialog).getByRole('combobox', { name: 'Model' })).toHaveValue(
      'claude-sonnet-5-5',
    );
    expect(aiAvailable()).toBe(false);
  });

  it('stores the key write-only and never shows it again', async () => {
    const { user, dialog } = await openAi();
    const setKey = vi.spyOn(backend, 'aiKeySet');
    await user.click(within(dialog).getByRole('button', { name: 'Add Key' }));
    const field = within(dialog).getByLabelText('Anthropic API key');
    expect(field).toHaveAttribute('type', 'password');
    await user.type(field, KEY);
    await user.click(within(dialog).getByRole('button', { name: 'Save Key' }));
    expect(await within(dialog).findByText('Stored in the system credential store.')).toBeVisible();
    expect(setKey).toHaveBeenCalledWith(KEY);
    // The key is gone from the page: no field holds it, no text shows it.
    expect(within(dialog).queryByLabelText('Anthropic API key')).toBeNull();
    expect(document.body.innerHTML).not.toContain('Canary-0042');
    expect(JSON.stringify(useAi.getState().status)).not.toContain('Canary-0042');

    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await within(dialog).findByText('No key stored.')).toBeVisible();
  });

  it('streams the test answer as it arrives and can cancel it', async () => {
    const { user, dialog } = await openAi();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Enable AI features' }));
    await waitFor(() => expect(useAi.getState().status.active).toBe(true));
    await user.click(within(dialog).getByRole('button', { name: 'Add Key' }));
    await user.type(within(dialog).getByLabelText('Anthropic API key'), KEY);
    await user.click(within(dialog).getByRole('button', { name: 'Save Key' }));
    await within(dialog).findByText('Stored in the system credential store.');
    expect(aiAvailable()).toBe(true);

    let emit: (e: AiStreamEvent) => void = () => {};
    vi.spyOn(backend, 'aiTest').mockImplementation(async (onEvent) => {
      emit = onEvent;
      return 'req-1';
    });
    const cancel = vi.spyOn(backend, 'aiCancel');
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    const result = within(dialog).getByRole('status', { name: 'Test result' });
    expect(result).toHaveTextContent('Waiting for the answer');
    act(() => emit({ type: 'started', model: 'claude-sonnet-5-5' }));
    act(() => emit({ type: 'text', text: 'Hel' }));
    expect(result).toHaveTextContent(/^Hel$/);
    act(() => emit({ type: 'text', text: 'lo' }));
    expect(result).toHaveTextContent(/^Hello$/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel Test' }));
    expect(cancel).toHaveBeenCalledWith('req-1');
    expect(result).toHaveTextContent('Cancelled.');
    expect(result).toHaveTextContent('Hello');

    // A complete run reports the usage.
    await user.click(within(dialog).getByRole('button', { name: 'Test' }));
    act(() => emit({ type: 'text', text: 'OK' }));
    act(() =>
      emit({
        type: 'done',
        stopReason: 'end_turn',
        usage: {
          inputTokens: 21,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    );
    expect(within(dialog).getByRole('status', { name: 'Test result' })).toHaveTextContent(
      'Connected. 21 input and 3 output tokens.',
    );
  });

  it('the in-memory backend refuses a test while AI is off', async () => {
    await backend.aiKeySet(KEY);
    await expect(backend.aiTest(() => {})).rejects.toMatchObject({ kind: 'ai_disabled' });
    await backend.aiSettingsSet({ ...DEFAULT_AI_SETTINGS, enabled: true });
    const events: AiStreamEvent[] = [];
    await backend.aiTest((e) => events.push(e));
    await waitFor(() => expect(events.at(-1)?.type).toBe('done'));
    expect(events.map((e) => e.type)).toEqual(['started', 'text', 'text', 'done']);
  });

  it('turning AI off for the workspace switches it off', async () => {
    const { user, dialog } = await openAi();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Enable AI features' }));
    await waitFor(() => expect(useAi.getState().status.active).toBe(true));
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Turn AI off in this workspace' }),
    );
    await waitFor(() => expect(useAi.getState().status.active).toBe(false));
    expect(useAi.getState().status.settings.enabled).toBe(true);
    expect(within(dialog).getByText(/AI is off: AI actions are hidden/)).toBeVisible();
  });

  it('edits the ignore list', async () => {
    const { user, dialog } = await openAi();
    await user.type(within(dialog).getByLabelText('Pattern'), 'billing.*');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'column');
    await user.type(within(dialog).getByLabelText('Pattern'), '*password*');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    const list = await within(dialog).findByRole('list', { name: 'Ignore list' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(useAi.getState().status.settings.ignore).toEqual([
      { kind: 'table', pattern: 'billing.*' },
      { kind: 'column', pattern: '*password*' },
    ]);
    // A table pattern has at most two parts.
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'table');
    await user.type(within(dialog).getByLabelText('Pattern'), 'a.b.c');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('a.b.c');
    await user.click(within(dialog).getByRole('button', { name: 'Remove table billing.*' }));
    await waitFor(() =>
      expect(useAi.getState().status.settings.ignore).toEqual([
        { kind: 'column', pattern: '*password*' },
      ]),
    );
  });
});
