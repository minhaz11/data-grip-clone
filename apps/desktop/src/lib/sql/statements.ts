/** A statement's span in the source text: `[start, end)`, `end` excludes the terminating `;`. */
export interface Span {
  start: number;
  end: number;
}

/**
 * Splits PostgreSQL text into statements on top-level `;`. Understands '…' strings (with ''),
 * E'…' strings (with backslash escapes), "…" identifiers, -- and nested /* *\/ comments, and
 * $tag$…$tag$ dollar quoting. Whitespace-only pieces are dropped.
 */
export function splitStatements(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;

  const push = (end: number) => {
    if (text.slice(start, end).trim() !== '') spans.push(trim({ start, end }, text));
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '-' && next === '-') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (c === "'") {
      const escapes = i > 0 && /[eE]/.test(text[i - 1] ?? '') && !/\w/.test(text[i - 2] ?? '');
      i++;
      while (i < n) {
        if (escapes && text[i] === '\\') i += 2;
        else if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") break;
        else i++;
      }
      i++;
    } else if (c === '"') {
      i++;
      while (i < n && !(text[i] === '"' && text[i + 1] !== '"')) i += text[i] === '"' ? 2 : 1;
      i++;
    } else if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (tag && !/\w/.test(text[i - 1] ?? '')) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        i = close < 0 ? n : close + tag[0].length;
      } else i++;
    } else if (c === ';') {
      push(i);
      start = i + 1;
      i++;
    } else i++;
  }
  push(n);
  return spans;
}

function trim(span: Span, text: string): Span {
  let { start, end } = span;
  while (start < end && /\s/.test(text[start] ?? '')) start++;
  while (end > start && /\s/.test(text[end - 1] ?? '')) end--;
  return { start, end };
}

/**
 * The statement under the caret. A caret just after a statement's `;` (or in trailing blank space)
 * belongs to the statement before it, matching how users expect "run current statement" to work.
 */
export function statementAt(text: string, offset: number): Span | null {
  const spans = splitStatements(text);
  let best: Span | null = null;
  for (const s of spans) {
    if (offset >= s.start && offset <= s.end + 1) return s;
    if (s.end < offset) best = s;
  }
  return best ?? spans[0] ?? null;
}

/** The statement containing the caret (up to just after its `;`), or `null` when it is outside all. */
export function statementContaining(text: string, offset: number): Span | null {
  return splitStatements(text).find((s) => offset >= s.start && offset <= s.end + 1) ?? null;
}
