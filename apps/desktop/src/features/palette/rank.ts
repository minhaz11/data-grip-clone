/** What the palette searches: database objects, consoles and actions. */
export type ItemType = 'table' | 'view' | 'routine' | 'sequence' | 'console' | 'action';

/** Type prefixes that narrow a search ("/tables orders"). */
export const PREFIXES: Record<string, ItemType[]> = {
  '/tables': ['table'],
  '/views': ['view'],
  '/routines': ['routine'],
  '/sequences': ['sequence'],
  '/objects': ['table', 'view', 'routine', 'sequence'],
  '/consoles': ['console'],
  '/actions': ['action'],
};

/** Splits "/tables ord" into the type filter and the text; unknown prefixes are plain text. */
export function parseQuery(input: string): { types: ItemType[] | null; text: string } {
  const m = /^(\/[a-z]+)(?:\s+|$)(.*)$/i.exec(input.trimStart());
  const types = m?.[1] ? PREFIXES[m[1].toLowerCase()] : undefined;
  if (m && types) {
    return { types, text: (m[2] ?? '').trim() };
  }
  return { types: null, text: input.trim() };
}

/** Prefixes that start with what was typed (for completing "/ta" to "/tables"). */
export function prefixesFor(input: string): string[] {
  const t = input.trim().toLowerCase();
  return t.startsWith('/') && !t.includes(' ')
    ? Object.keys(PREFIXES).filter((p) => p.startsWith(t) && p !== t)
    : [];
}

/** Where a word starts in a name: after `_`, `.`, `-`, space, or a lower-to-upper case change. */
function wordStarts(name: string): number[] {
  const starts = [0];
  for (let i = 1; i < name.length; i++) {
    const prev = name[i - 1] ?? '';
    const c = name[i] ?? '';
    if (/[_.\-\s]/.test(prev) || (/[a-z0-9]/.test(prev) && /[A-Z]/.test(c))) {
      starts.push(i);
    }
  }
  return starts;
}

/**
 * How well `name` matches `query` (higher is better), or `null` for no match: exact, then prefix,
 * then the start of a word inside the name, then any substring, then the letters in order
 * (fuzzy). Case is ignored. An empty query matches everything equally.
 */
export function score(query: string, name: string): number | null {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  if (!q) {
    return 1;
  }
  if (n === q) {
    return 1000;
  }
  if (n.startsWith(q)) {
    return 800 - Math.min(100, n.length - q.length);
  }
  const at = n.indexOf(q);
  if (at > 0 && wordStarts(name).includes(at)) {
    return 600 - Math.min(100, at);
  }
  if (at > 0) {
    return 400 - Math.min(100, at);
  }
  // Fuzzy: every query letter in order; fewer gaps and earlier starts score higher.
  let from = 0;
  let gaps = 0;
  let first = -1;
  for (const c of q) {
    const i = n.indexOf(c, from);
    if (i < 0) {
      return null;
    }
    if (first < 0) {
      first = i;
    } else if (i > from) {
      gaps += 1;
    }
    from = i + 1;
  }
  return Math.max(1, 200 - gaps * 10 - Math.min(50, first));
}

export interface Rankable {
  type: ItemType;
  /** The name matched against the query. */
  name: string;
  /** Secondary text, also searched with a lower weight (schema, data source). */
  detail?: string;
}

/**
 * The items matching `input`, best first: by score, then shorter names, then alphabetically.
 * `limit` bounds the work done by sorting, not the scan.
 */
export function rank<T extends Rankable>(items: T[], input: string, limit = 200): T[] {
  const { types, text } = parseQuery(input);
  const scored: { item: T; s: number }[] = [];
  for (const item of items) {
    if (types && !types.includes(item.type)) {
      continue;
    }
    // "shop.orders": a qualified query matches schema and name separately.
    const dot = text.indexOf('.');
    let s: number | null;
    if (dot > 0 && item.detail) {
      const a = score(text.slice(0, dot), item.detail);
      const b = score(text.slice(dot + 1), item.name);
      s = a !== null && b !== null ? (a + b) / 2 : null;
    } else {
      s = score(text, item.name);
    }
    if (s !== null) {
      scored.push({ item, s });
    }
  }
  scored.sort(
    (a, b) =>
      b.s - a.s ||
      a.item.name.length - b.item.name.length ||
      a.item.name.localeCompare(b.item.name),
  );
  return scored.slice(0, limit).map((x) => x.item);
}
