import { create } from 'zustand';
import type { ObjectRef } from '../../ipc/types';
import { classify } from '../../lib/sql/classify';
import { splitStatements } from '../../lib/sql/statements';
import { quoteIdent } from '../editor/suggestions';

/**
 * The statement behind "Open data" (M4.8). The WHERE and ORDER BY text is the user's SQL: it is
 * wrapped, never parsed, so the closing parenthesis sits on its own line (a trailing `--` comment
 * cannot swallow it) and the result is checked like console SQL before it runs.
 */
export function browseSql(object: ObjectRef, where: string, orderBy: string): string {
  let sql = `SELECT * FROM ${quoteIdent(object.schema)}.${quoteIdent(object.name)}`;
  if (where.trim()) {
    sql += `\nWHERE (${where.trim()}\n)`;
  }
  if (orderBy.trim()) {
    sql += `\nORDER BY ${orderBy.trim()}`;
  }
  return sql;
}

/** Why the built statement must not run, if it must not: it has to stay one read statement. */
export function browseProblem(sql: string): string | null {
  if (splitStatements(sql).length !== 1) {
    return 'The filter and sort order cannot end the statement or add another one.';
  }
  if (classify(sql).kind !== 'read') {
    return 'Only a filter and a sort order can be added here.';
  }
  return null;
}

/** Recent filter and sort texts per table, newest first (kept for the app session). */
const MAX_HISTORY = 10;

interface BrowseHistory {
  entries: Record<string, { where: string[]; orderBy: string[] } | undefined>;
  remember(key: string, where: string, orderBy: string): void;
  clear(key: string): void;
}

const push = (list: string[], text: string) =>
  text.trim()
    ? [text.trim(), ...list.filter((t) => t !== text.trim())].slice(0, MAX_HISTORY)
    : list;

export const useBrowseHistory = create<BrowseHistory>((set) => ({
  entries: {},
  remember: (key, where, orderBy) =>
    set((s) => {
      const current = s.entries[key] ?? { where: [], orderBy: [] };
      return {
        entries: {
          ...s.entries,
          [key]: { where: push(current.where, where), orderBy: push(current.orderBy, orderBy) },
        },
      };
    }),
  clear: (key) => set((s) => ({ entries: { ...s.entries, [key]: undefined } })),
}));

export function historyKey(sourceId: string, object: ObjectRef): string {
  return `${sourceId}\u001f${object.schema}\u001f${object.name}`;
}
