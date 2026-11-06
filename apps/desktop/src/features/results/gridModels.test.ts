import { describe, expect, it } from 'vitest';
import { aggregate } from './aggregates';
import {
  displayColumns,
  hideColumn,
  isDefault,
  moveColumn,
  NO_LAYOUT,
  showAllColumns,
  signature,
} from './columnLayout';
import { loadPages, MAX_PAGES_IN_FLIGHT } from './pageLoader';
import { clampSelection, extend, inRange, rangeOf, selectAll, single } from './selection';

describe('selection', () => {
  it('normalizes a range whichever way it was dragged', () => {
    const sel = extend(single({ row: 5, col: 3 }), { row: 2, col: 1 });
    const r = rangeOf(sel);
    expect(r).toEqual({ top: 2, bottom: 5, left: 1, right: 3 });
    expect(inRange(r, 2, 1)).toBe(true);
    expect(inRange(r, 6, 1)).toBe(false);
    expect(rangeOf(selectAll(10, 4))).toEqual({ top: 0, bottom: 9, left: 0, right: 3 });
  });

  it('stays inside a grid that shrank', () => {
    const sel = extend(single({ row: 1, col: 1 }), { row: 9, col: 5 });
    expect(clampSelection(sel, 4, 2)).toEqual({
      anchor: { row: 1, col: 1 },
      focus: { row: 3, col: 1 },
    });
    expect(clampSelection(sel, 0, 2)).toBeNull();
  });
});

describe('aggregates', () => {
  it('sums plain decimals exactly, beyond floating point', () => {
    const a = aggregate(['9007199254740993', '1', '0.10', '0.2'], 5);
    expect(a).toEqual({
      count: 5,
      numeric: 4,
      sum: '9007199254740994.3',
      avg: '2251799813685248.575',
      min: '0.1',
      max: '9007199254740993',
      approximate: false,
    });
  });

  it('handles negatives and rounds the average', () => {
    expect(aggregate(['-1', '-2'], 2)).toMatchObject({
      sum: '-3',
      avg: '-1.5',
      min: '-2',
      max: '-1',
    });
    expect(aggregate(['1', '1', '2'], 3)?.avg).toBe('1.333333');
    expect(aggregate(['-1', '-1', '-2'], 3)?.avg).toBe('-1.333333');
  });

  it('falls back to floating point for exponents and skips NaN', () => {
    expect(aggregate(['1e3', '5', 'NaN'], 3)).toMatchObject({
      numeric: 2,
      sum: '1005',
      approximate: true,
    });
    expect(aggregate([], 3)).toBeNull();
    expect(aggregate(['NaN'], 1)).toBeNull();
  });
});

describe('column layout', () => {
  it('orders, hides and shows columns by result index', () => {
    expect(displayColumns(4)).toEqual([0, 1, 2, 3]);
    let layout = moveColumn(4, NO_LAYOUT, 3, 0);
    expect(displayColumns(4, layout)).toEqual([3, 0, 1, 2]);
    layout = hideColumn(4, layout, 1);
    expect(displayColumns(4, layout)).toEqual([3, 0, 2]);
    // Moving among shown columns keeps the hidden one hidden.
    layout = moveColumn(4, layout, 0, 2);
    expect(displayColumns(4, layout)).toEqual([0, 2, 3]);
    expect(displayColumns(4, showAllColumns(layout))).toEqual([0, 2, 3, 1]);
    expect(isDefault(layout, 4)).toBe(false);
    expect(isDefault({ order: [0, 1], hidden: [] }, 4)).toBe(true);
  });

  it('never hides the last column and ignores stale indices', () => {
    const one = hideColumn(2, hideColumn(2, NO_LAYOUT, 0), 1);
    expect(displayColumns(2, one)).toEqual([1]);
    expect(displayColumns(2, { order: [5, 1, 1], hidden: [0, 1] })).toEqual([0, 1]);
  });

  it('identifies a result by column names and types', () => {
    expect(signature([{ name: 'id', typeName: 'int4' }])).not.toBe(
      signature([{ name: 'id', typeName: 'int8' }]),
    );
  });
});

describe('loadPages', () => {
  it('never has more than two page requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetched: number[] = [];
    const fetch = async (page: number) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      fetched.push(page);
      return [[String(page)]];
    };
    const cache = new Map([[3, [['cached']]]]);
    const pages = await loadPages([0, 1, 2, 3, 4, 5, 6], (p) => cache.get(p), fetch);
    expect(peak).toBe(MAX_PAGES_IN_FLIGHT);
    expect(fetched.sort()).toEqual([0, 1, 2, 4, 5, 6]);
    expect(pages.get(3)).toEqual([['cached']]);
    expect([...pages.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
