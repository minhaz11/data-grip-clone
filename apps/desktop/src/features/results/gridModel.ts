/** Pure geometry and paging maths for the virtualized grid (no DOM), so it is unit-testable. */

export const ROW_HEIGHT = 22;
export const PAGE_SIZE = 500;
/** Browsers cap element heights (WebKit ~33M px); stay well below and scale scrolling beyond. */
export const MAX_SCROLL_PX = 8_000_000;
export const OVERSCAN = 8;

export interface Window {
  /** First row index to render. */
  first: number;
  /** One past the last row index to render. */
  last: number;
  /** Pixel offset of row `first` relative to the top of the viewport body (≤ 0). */
  shift: number;
  /** Height of the scroll spacer for the rows. */
  scrollHeight: number;
}

/**
 * Rows visible for a scroll position. When the full list is taller than `MAX_SCROLL_PX`, the
 * scrollbar range maps linearly onto it, so every row stays reachable.
 */
export function visibleWindow(totalRows: number, scrollTop: number, viewport: number): Window {
  const full = totalRows * ROW_HEIGHT;
  const scrollHeight = Math.min(full, MAX_SCROLL_PX);
  const maxScroll = Math.max(0, scrollHeight - viewport);
  const maxReal = Math.max(0, full - viewport);
  const top = Math.min(Math.max(0, scrollTop), maxScroll);
  const real = maxScroll > 0 ? (top / maxScroll) * maxReal : 0;
  const firstVisible = Math.floor(real / ROW_HEIGHT);
  const first = Math.max(0, firstVisible - OVERSCAN);
  const last = Math.min(totalRows, firstVisible + Math.ceil(viewport / ROW_HEIGHT) + 1 + OVERSCAN);
  return { first, last, shift: first * ROW_HEIGHT - real, scrollHeight };
}

/** Pages needed to show rows `[first, last)`. */
export function pagesFor(first: number, last: number): number[] {
  if (last <= first) return [];
  const pages: number[] = [];
  for (let p = Math.floor(first / PAGE_SIZE); p <= Math.floor((last - 1) / PAGE_SIZE); p++)
    pages.push(p);
  return pages;
}

/** Scroll position that brings `row` into view (for keyboard navigation). */
export function scrollTopFor(
  row: number,
  totalRows: number,
  viewport: number,
  current: number,
): number {
  const w = visibleWindow(totalRows, current, viewport);
  const full = totalRows * ROW_HEIGHT;
  const maxScroll = Math.max(0, w.scrollHeight - viewport);
  const maxReal = Math.max(0, full - viewport);
  const real =
    maxScroll > 0 ? (Math.min(Math.max(0, current), maxScroll) / maxScroll) * maxReal : 0;
  let target = real;
  if (row * ROW_HEIGHT < real) target = row * ROW_HEIGHT;
  else if ((row + 1) * ROW_HEIGHT > real + viewport) target = (row + 1) * ROW_HEIGHT - viewport;
  return maxReal > 0 ? (target / maxReal) * maxScroll : 0;
}

/** Initial column width from the header and a sample of values (monospace estimate). */
export function initialWidth(header: string, sample: (string | null)[]): number {
  const longest = Math.max(
    header.length + 6,
    ...sample.map((v) => (v === null ? 4 : Math.min(v.length, 60))),
  );
  return Math.min(400, Math.max(64, Math.round(longest * 7.4 + 16)));
}
