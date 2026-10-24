import type { Cell } from '../../ipc/types';

/** Page requests in flight at once when gathering rows (the M3.3 IPC rule). */
export const MAX_PAGES_IN_FLIGHT = 2;

/**
 * Returns `pages`, taking cached ones as they are and fetching the rest with at most
 * `MAX_PAGES_IN_FLIGHT` requests at a time, so copying a large selection never floods IPC.
 */
export async function loadPages(
  pages: number[],
  cached: (page: number) => Cell[][] | undefined,
  fetch: (page: number) => Promise<Cell[][]>,
): Promise<Map<number, Cell[][]>> {
  const out = new Map<number, Cell[][]>();
  const missing: number[] = [];
  for (const page of pages) {
    const rows = cached(page);
    if (rows) {
      out.set(page, rows);
    } else {
      missing.push(page);
    }
  }
  let next = 0;
  async function worker() {
    while (next < missing.length) {
      const page = missing[next] as number;
      next += 1;
      out.set(page, await fetch(page));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(MAX_PAGES_IN_FLIGHT, missing.length) }, () => worker()),
  );
  return out;
}
