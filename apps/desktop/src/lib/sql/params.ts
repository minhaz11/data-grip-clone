import type { Cell } from '../../ipc/types';

/** A parameter in a statement: `:name`, `${name}` or `$1`. */
export interface ParamRef {
  start: number;
  end: number;
  /** The value's key: `id` for both `:id` and `${id}`, `1` for `$1`. */
  name: string;
  positional: boolean;
}

const WORD = /[\w$]/;

/**
 * Parameters in one statement (REQ-EDIT-10). Strings, `E'…'` strings, quoted identifiers,
 * comments and dollar-quoted bodies are skipped, so `$1` inside a function body is not one;
 * `::type` casts and `:=` are not parameters, nor is `x:y` (array slices). `PREPARE` statements
 * define their own `$n` and are left alone.
 */
export function findParameters(sql: string): ParamRef[] {
  if (/^\s*prepare\b/i.test(sql)) {
    return [];
  }
  const refs: ParamRef[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
    } else if (c === "'") {
      const escapes = i > 0 && /[eE]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '');
      i++;
      while (i < n) {
        if (escapes && sql[i] === '\\') {
          i += 2;
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          break;
        } else {
          i++;
        }
      }
      i++;
    } else if (c === '"') {
      i++;
      while (i < n && !(sql[i] === '"' && sql[i + 1] !== '"')) {
        i += sql[i] === '"' ? 2 : 1;
      }
      i++;
    } else if (c === '$') {
      const before = sql[i - 1] ?? '';
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      const template = /^\$\{([A-Za-z_]\w*)\}/.exec(sql.slice(i));
      const positional = /^\$(\d+)/.exec(sql.slice(i));
      if (template?.[1]) {
        refs.push({ start: i, end: i + template[0].length, name: template[1], positional: false });
        i += template[0].length;
      } else if (positional?.[1] && !WORD.test(before)) {
        refs.push({
          start: i,
          end: i + positional[0].length,
          name: String(Number(positional[1])),
          positional: true,
        });
        i += positional[0].length;
      } else if (tag && !WORD.test(before)) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close < 0 ? n : close + tag[0].length;
      } else {
        i++;
      }
    } else if (c === ':') {
      if (next === ':' || next === '=') {
        i += 2;
        continue;
      }
      const named = /^:([A-Za-z_]\w*)/.exec(sql.slice(i));
      const before = sql[i - 1] ?? '';
      if (named?.[1] && !/[\w\])]/.test(before)) {
        refs.push({ start: i, end: i + named[0].length, name: named[1], positional: false });
        i += named[0].length;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return refs;
}

/** Distinct parameter names of some statements, in first-appearance order. */
export function parameterNames(statements: string[]): string[] {
  const names: string[] = [];
  for (const sql of statements) {
    for (const p of findParameters(sql)) {
      if (!names.includes(p.name)) {
        names.push(p.name);
      }
    }
  }
  return names;
}

/**
 * The statement with named parameters turned into `$n` placeholders, and the values in `$n`
 * order. `$1…` keep their numbers; names take the numbers after the highest one, the same
 * name always the same number. Values are bound, never spliced into the text, and the text
 * keeps its length where it can.
 */
export function bindParameters(
  sql: string,
  values: Record<string, Cell>,
): { sql: string; params: Cell[] } {
  const refs = findParameters(sql);
  if (refs.length === 0) {
    return { sql, params: [] };
  }
  let top = Math.max(0, ...refs.filter((r) => r.positional).map((r) => Number(r.name)));
  const numbers = new Map<string, number>();
  for (const r of refs) {
    if (!r.positional && !numbers.has(r.name)) {
      top += 1;
      numbers.set(r.name, top);
    }
  }
  let out = '';
  let at = 0;
  for (const r of refs) {
    // Padded to the original length, so server error positions still point into the console.
    const placeholder = r.positional ? `$${r.name}` : `$${numbers.get(r.name)}`;
    out += sql.slice(at, r.start) + placeholder.padEnd(r.end - r.start, ' ');
    at = r.end;
  }
  out += sql.slice(at);
  const params: Cell[] = Array.from({ length: top }, () => null);
  for (const r of refs) {
    const n = r.positional ? Number(r.name) : (numbers.get(r.name) ?? 0);
    params[n - 1] = values[r.name] ?? null;
  }
  return { sql: out, params };
}
