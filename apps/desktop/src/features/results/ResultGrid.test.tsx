import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backend } from '../../ipc/client';
import type { Cell, StatementOutcome } from '../../ipc/types';
import { MAX_SCROLL_PX, PAGE_SIZE } from './gridModel';
import { ResultGrid } from './ResultGrid';

type RowsOutcome = Extract<StatementOutcome, { type: 'rows' }>;

const COLUMNS = [
  { name: 'g', typeName: 'int4' },
  { name: 'h', typeName: 'text' },
];
const rowsAt = (offset: number, limit: number, total: number): Cell[][] =>
  Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => [
    String(offset + i + 1),
    i % 7 === 0 ? null : `h${offset + i + 1}`,
  ]);

function million(): RowsOutcome {
  return {
    type: 'rows',
    columns: COLUMNS,
    rows: rowsAt(0, PAGE_SIZE, 1_000_000),
    totalRows: 1_000_000,
    truncated: true,
    cursor: 'quarry_cursor_1',
  };
}

afterEach(() => vi.restoreAllMocks());

function scrollTo(grid: HTMLElement, top: number) {
  act(() => {
    grid.scrollTop = top;
    fireEvent.scroll(grid);
  });
}

describe('ResultGrid', () => {
  it('pages a 1M-row cursor result, requesting at most two pages per viewport', async () => {
    const page = vi
      .spyOn(backend, 'resultPage')
      .mockImplementation(async (_s, _c, offset, limit) => rowsAt(offset, limit, 1_000_000));
    render(
      <ResultGrid
        session={{ sourceId: 'src' }}
        outcome={million()}
        exportName="console_result_1"
      />,
    );
    const grid = screen.getByRole('grid', { name: 'Result rows' });
    expect(grid).toHaveAttribute('aria-rowcount', '1000001');
    expect(page).not.toHaveBeenCalled(); // the first page arrived with the result
    expect(within(grid).getByText('h2')).toBeInTheDocument();

    scrollTo(grid, MAX_SCROLL_PX); // all the way down
    await waitFor(() => expect(within(grid).getByText('h1000000')).toBeInTheDocument());
    expect(page.mock.calls.length).toBeLessThanOrEqual(2);
    for (const [, cursor, offset, limit] of page.mock.calls) {
      expect(cursor).toBe('quarry_cursor_1');
      expect(limit).toBe(PAGE_SIZE);
      expect(offset).toBeGreaterThanOrEqual(999_000);
    }
    // The last row is rendered with its row number and values.
    const last = grid.querySelector('[aria-rowindex="1000001"]');
    expect(last).not.toBeNull();
    expect(Array.from(last?.children ?? []).map((c) => c.textContent)).toEqual([
      '1000000',
      '1000000',
      'h1000000',
    ]);

    // Scrolling back to a cached page does not refetch it.
    const calls = page.mock.calls.length;
    scrollTo(grid, 0);
    scrollTo(grid, MAX_SCROLL_PX);
    await waitFor(() => expect(within(grid).getByText('h1000000')).toBeInTheDocument());
    expect(page.mock.calls.length).toBe(calls);
  });

  it('moves the selection with the keyboard and copies the cell', async () => {
    const write = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText: write } });
    const outcome: RowsOutcome = {
      type: 'rows',
      columns: COLUMNS,
      rows: rowsAt(0, 3, 3),
      totalRows: 3,
      truncated: false,
      cursor: 'c',
    };
    render(<ResultGrid session={{ sourceId: 'src' }} outcome={outcome} exportName="x" />);
    const grid = screen.getByRole('grid');
    act(() => grid.focus());
    await userEvent.keyboard('{ArrowDown}{ArrowRight}');
    const selected = within(grid)
      .getAllByRole('gridcell')
      .filter((c) => c.getAttribute('aria-selected') === 'true');
    expect(selected.map((c) => c.textContent)).toEqual(['h2']);
    await userEvent.keyboard('{Control>}c{/Control}');
    expect(write).toHaveBeenCalledWith('h2');
    await userEvent.keyboard('{ArrowUp}{Control>}c{/Control}');
    expect(write).toHaveBeenLastCalledWith(''); // NULL copies as empty text
  });

  it('exports through the backend with progress and a summary', async () => {
    let finish: (v: { path: string; rows: number; bytes: number } | null) => void = () => {};
    const exp = vi
      .spyOn(backend, 'resultExport')
      .mockImplementation((_s, _c, _cols, _f, _n, onProgress) => {
        onProgress(5000);
        return new Promise((resolve) => (finish = resolve));
      });
    const user = userEvent.setup();
    render(
      <ResultGrid
        session={{ sourceId: 'src' }}
        outcome={million()}
        exportName="console_result_1"
      />,
    );
    await user.click(screen.getByRole('button', { name: /CSV/ }));
    expect(exp).toHaveBeenCalledWith(
      { sourceId: 'src' },
      'quarry_cursor_1',
      COLUMNS,
      'csv',
      'console_result_1',
      expect.any(Function),
    );
    expect(await screen.findByText(/Exporting CSV… 5,000 rows/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /JSON/ })).toBeDisabled();
    await act(async () =>
      finish({ path: '/home/u/out/console_result_1.csv', rows: 1_000_000, bytes: 123 }),
    );
    expect(screen.getByText('Exported 1,000,000 rows to console_result_1.csv')).toBeInTheDocument();
  });

  it('treats a cancelled save dialog as no-op and reports export failures', async () => {
    const exp = vi
      .spyOn(backend, 'resultExport')
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce({ kind: 'storage', message: 'disk full' });
    const user = userEvent.setup();
    render(<ResultGrid session={{ sourceId: 'src' }} outcome={million()} exportName="r" />);
    await user.click(screen.getByRole('button', { name: /JSON/ }));
    await waitFor(() => expect(exp).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /JSON/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Export failed: disk full');
  });

  it('explains capped results that cannot be paged or exported', () => {
    const outcome: RowsOutcome = {
      type: 'rows',
      columns: COLUMNS,
      rows: rowsAt(0, 500, 500),
      totalRows: 2000,
      truncated: true,
    };
    render(<ResultGrid session={{ sourceId: 'src' }} outcome={outcome} exportName="r" />);
    expect(
      screen.getByText(/2,000 rows \(first 500 shown; this statement cannot be paged\)/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /CSV/ })).toBeDisabled();
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '501');
  });
});
