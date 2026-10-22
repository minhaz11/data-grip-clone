import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useSettings } from '../../app/settingsStore';
import { useWorkspace } from '../../app/workspaceStore';
import { backend, type Backend } from '../../ipc/client';
import { DEFAULT_SETTINGS } from '../../ipc/types';
import { MAX_KEPT_RESULTS, useExec } from '../exec/execStore';
import { BottomPanel } from './BottomPanel';

let execute: MockInstance<Backend['queryExecute']>;
let close: MockInstance<Backend['resultClose']>;
let cursor = 0;

beforeEach(() => {
  cursor = 0;
  useExec.setState({ runs: {}, view: {}, kept: {} });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  useWorkspace.setState({
    tabs: [{ id: 't1', console: 'console', sourceId: 'src', text: '', save: 'saved' }],
    activeTabId: 't1',
  });
  close = vi.spyOn(backend, 'resultClose').mockResolvedValue(null);
  // Every run returns one result set with a fresh cursor.
  execute = vi.spyOn(backend, 'queryExecute').mockImplementation(async (_req, onEvent) => {
    cursor += 1;
    const name = `cur${cursor}`;
    queueMicrotask(() => {
      onEvent({
        event: 'statementDone',
        index: 0,
        offset: 0,
        elapsedMs: 1,
        outcome: {
          type: 'rows',
          columns: [{ name: 'n', typeName: 'int4' }],
          rows: [[String(cursor)]],
          totalRows: 1,
          truncated: false,
          cursor: name,
        },
      });
      onEvent({ event: 'finished', status: 'completed', executed: 1, elapsedMs: 1 });
    });
    return `job-${cursor}`;
  });
});
afterEach(() => vi.restoreAllMocks());

async function run() {
  const n = execute.mock.calls.length;
  await act(() =>
    useExec
      .getState()
      .start('t1', { sourceId: 'src' }, 'Dev', [{ sql: 'select 1', offset: 0 }], { schema: null }),
  );
  await waitFor(() => expect(useExec.getState().runs.t1?.status).toBe('completed'));
  expect(execute).toHaveBeenCalledTimes(n + 1);
}

const closed = () => close.mock.calls.map(([, c]) => c);
const kept = () => (useExec.getState().kept.t1 ?? []).map((id) => useExec.getState().runs[id]);

describe('pinned and kept results', () => {
  it('replaces results on a new run but keeps pinned ones with their cursor', async () => {
    await run();
    const pinned = useExec.getState().pin('t1', 0);
    expect(pinned).not.toBeNull();
    expect(useExec.getState().view.t1).toBe(pinned);
    await run();
    // The pinned cursor stays open; the replaced current result (none: it was moved) is not closed.
    expect(closed()).toEqual([]);
    await run();
    expect(closed()).toEqual(['cur2']); // the unpinned result of run 2 was replaced
    expect(kept().map((k) => [k?.pinned, k?.statements[0]?.outcome])).toEqual([
      [true, expect.objectContaining({ cursor: 'cur1' })],
    ]);
    useExec.getState().closeKept(pinned as string);
    expect(closed()).toEqual(['cur2', 'cur1']);
    expect(kept()).toEqual([]);
  });

  it('keeps every run as a tab when set to, closing the oldest beyond the limit', async () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, resultTabs: 'new' } });
    for (let i = 0; i < MAX_KEPT_RESULTS + 3; i++) {
      await run();
    }
    // Runs 1..(MAX+2) were kept; the oldest beyond the limit were closed.
    expect(kept()).toHaveLength(MAX_KEPT_RESULTS);
    expect(closed()).toEqual(['cur1', 'cur2']);
    expect(kept().every((k) => k?.pinned === false)).toBe(true);
    // Switching back to replacing drops the unpinned kept results on the next run.
    useSettings.setState({ settings: DEFAULT_SETTINGS });
    await run();
    expect(kept()).toEqual([]);
  });

  it('shows kept results as tabs with Pin, Unpin and Close', async () => {
    const user = userEvent.setup();
    render(<BottomPanel />);
    await run();
    await user.click(screen.getByRole('tab', { name: 'Result 1' }));
    await user.click(screen.getByRole('button', { name: 'Pin' }));
    const pinnedTab = screen.getByRole('tab', { name: /pinned.*Result 1 ·/ });
    expect(pinnedTab).toHaveAttribute('aria-selected', 'true');
    // The current run has no result tab left: the result moved.
    expect(screen.queryByRole('tab', { name: 'Result 1' })).not.toBeInTheDocument();

    await run();
    expect(screen.getByRole('tab', { name: 'Result 1' })).toBeInTheDocument();
    await user.click(pinnedTab);
    await user.click(screen.getByRole('button', { name: 'Unpin' }));
    expect(useExec.getState().runs[useExec.getState().kept.t1?.[0] ?? '']?.pinned).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('tab', { name: /Result 1 ·/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole('tablist')).getAllByRole('tab')).toHaveLength(2);
  });
});
