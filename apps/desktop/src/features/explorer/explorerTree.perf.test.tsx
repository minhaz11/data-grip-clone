// Wall-clock budget, run by the "perf" Vitest project after all other tests and one file at a
// time, so parallel workers do not skew the timing.
import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessions } from '../connections/sessionsStore';
import { registerExplorerHarness, setup } from './explorerTestKit';
import { useMetadata } from './metadataStore';

registerExplorerHarness();

describe('explorer metadata tree performance', () => {
  it('expands a 1,000-table level within the 1 s budget', async () => {
    const many = Array.from({ length: 1000 }, (_, i) => `t_${String(i).padStart(4, '0')}`);
    const { p } = await setup(many);
    await act(async () => {
      await useSessions.getState().connect(p.id);
    });
    const tablesKey = [p.id, 's:shop', 'g:tables'].join('\u001f');
    await act(async () => {
      useMetadata.setState({
        expanded: { [p.id]: true, [[p.id, 's:shop'].join('\u001f')]: true },
      });
    });
    await screen.findByRole('treeitem', { name: /^Tables, folder, 1000/ });

    const started = performance.now();
    await act(async () => useMetadata.getState().setExpanded(tablesKey, true));
    // Wait on the store, not the DOM: DOM queries re-run on every mutation while 1,000 rows render
    // and would dominate the measurement. Leaving `act` commits the render of the loaded level.
    await act(() =>
      vi.waitFor(() => expect(useMetadata.getState().children[tablesKey]?.status).toBe('loaded'), {
        interval: 5,
      }),
    );
    const elapsed = performance.now() - started;
    expect(screen.getByText('t_0999')).toBeInTheDocument();
    // Role queries compute accessible names for every row, which is slow in jsdom and says nothing
    // about the UI's cost, so they stay outside the timed section.
    expect(screen.getAllByRole('treeitem', { name: /, table$/ })).toHaveLength(1000);
    // jsdom is slower than WebKit/Chromium, so this bounds the real UI cost from above.
    expect(elapsed).toBeLessThan(1000);
  });
});
