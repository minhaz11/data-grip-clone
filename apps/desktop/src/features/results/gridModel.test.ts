import { describe, expect, it } from 'vitest';
import {
  initialWidth,
  MAX_SCROLL_PX,
  OVERSCAN,
  pagesFor,
  ROW_HEIGHT,
  scrollTopFor,
  visibleWindow,
} from './gridModel';

describe('grid windowing', () => {
  it('renders only the rows in view plus overscan', () => {
    const w = visibleWindow(10_000, 0, 220);
    expect(w).toEqual({
      first: 0,
      last: 11 + OVERSCAN,
      shift: 0,
      scrollHeight: 10_000 * ROW_HEIGHT,
    });
    const mid = visibleWindow(10_000, 5_000 * ROW_HEIGHT, 220);
    expect(mid.first).toBe(5_000 - OVERSCAN);
    expect(mid.last - mid.first).toBeLessThan(40);
  });

  it('scales scrolling for results taller than the browser limit and still reaches the last row', () => {
    const rows = 1_000_000;
    const viewport = 440;
    const end = visibleWindow(rows, MAX_SCROLL_PX, viewport);
    expect(end.scrollHeight).toBe(MAX_SCROLL_PX);
    expect(end.last).toBe(rows);
    expect(end.first).toBeGreaterThan(rows - 40);
    // Halfway down the scrollbar is roughly halfway through the rows.
    const half = visibleWindow(rows, (MAX_SCROLL_PX - viewport) / 2, viewport);
    expect(Math.abs(half.first + OVERSCAN - rows / 2)).toBeLessThan(20);
  });

  it('needs at most two pages for any viewport', () => {
    expect(pagesFor(0, 30)).toEqual([0]);
    expect(pagesFor(490, 520)).toEqual([0, 1]);
    expect(pagesFor(999_500, 1_000_000)).toEqual([1999]);
    expect(pagesFor(999_480, 1_000_000)).toEqual([1998, 1999]);
    for (const top of [0, 123_456, 4_000_000, MAX_SCROLL_PX]) {
      const w = visibleWindow(1_000_000, top, 600);
      expect(pagesFor(w.first, w.last).length).toBeLessThanOrEqual(2);
    }
  });

  it('scrolls a row into view with minimal movement', () => {
    expect(scrollTopFor(0, 1000, 220, 0)).toBe(0);
    expect(scrollTopFor(20, 1000, 220, 0)).toBeCloseTo(21 * ROW_HEIGHT - 220);
    expect(scrollTopFor(5, 1000, 220, 10 * ROW_HEIGHT)).toBeCloseTo(5 * ROW_HEIGHT);
  });

  it('estimates column widths within bounds', () => {
    // Room for the header plus its type label.
    expect(initialWidth('id', ['1', '2'])).toBe(75);
    expect(initialWidth('', [])).toBe(64);
    expect(initialWidth('email', ['someone@example.test'])).toBeGreaterThan(150);
    expect(initialWidth('blob', ['x'.repeat(5000)])).toBe(400);
  });
});
