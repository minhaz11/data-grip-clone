import { maskLiterals } from './completionContext';

/** What a statement does, for safety guards. `unknown` is treated like a write. */
export type StatementKind = 'read' | 'write' | 'ddl' | 'session' | 'unknown';

export interface Classification {
  kind: StatementKind;
  /** Why it is destructive (irreversible or touching every row), if it is. */
  destructive?: string;
  /** Why it could let later statements write on a read-only source, if it could. */
  unlocksWrites?: string;
}

const READ = new Set(['SELECT', 'VALUES', 'TABLE', 'SHOW', 'FETCH']);
const WRITE = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'COPY',
  'CALL',
  'DO',
  'LOCK',
  'REFRESH',
  'IMPORT',
]);
const DDL = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'COMMENT',
  'GRANT',
  'REVOKE',
  'REINDEX',
  'CLUSTER',
  'VACUUM',
  'ANALYZE',
  'ANALYSE',
  'SECURITY',
  'REASSIGN',
]);
const SESSION = new Set([
  'BEGIN',
  'START',
  'COMMIT',
  'END',
  'ROLLBACK',
  'ABORT',
  'SAVEPOINT',
  'RELEASE',
  'SET',
  'RESET',
  'DISCARD',
  'PREPARE',
  'DEALLOCATE',
  'LISTEN',
  'UNLISTEN',
  'NOTIFY',
  'CHECKPOINT',
  'DECLARE',
  'CLOSE',
  'MOVE',
]);

/** Upper-cased words of already-masked code. */
function words(code: string): string[] {
  return code.toUpperCase().match(/[A-Z_][A-Z0-9_$]*/g) ?? [];
}

/** Words at parenthesis depth 0 only (so subqueries and CTE bodies do not count). */
function topLevelWords(code: string): string[] {
  let depth = 0;
  let out = '';
  for (const ch of code) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    out += depth === 0 ? ch : ' ';
  }
  return words(out);
}

export function classify(sql: string): Classification {
  const code = maskLiterals(sql).replace(/"(?:[^"]|"")*"/g, ' id '); // quoted identifiers are not keywords
  const top = topLevelWords(code);
  const first = top[0];
  if (!first) return { kind: 'unknown' };

  if (first === 'EXPLAIN') {
    // EXPLAIN ANALYZE really runs the statement; plain EXPLAIN does not.
    const all = words(code);
    const analyze =
      /\bEXPLAIN\s*(\([^)]*\bANALY[SZ]E\b[^)]*\)|\s+ANALY[SZ]E\b)/i.test(code) &&
      !/\bANALY[SZ]E\s+(FALSE|OFF|0)\b/i.test(code);
    if (!analyze) return { kind: 'read' };
    const inner = all.findIndex((w, i) => i > 0 && (READ.has(w) || WRITE.has(w) || w === 'WITH'));
    return inner > 0
      ? classify(sql.slice(code.toUpperCase().indexOf(all[inner] ?? '', 7)))
      : { kind: 'unknown' };
  }

  if (first === 'WITH') {
    // A CTE writes if any data-modifying keyword appears, top level or inside a CTE body.
    const all = words(code);
    if (all.some((w) => w === 'INSERT' || w === 'UPDATE' || w === 'DELETE' || w === 'MERGE')) {
      const mainVerb = top.find((w) => WRITE.has(w));
      return { kind: 'write', destructive: mainVerb ? destructiveDml(mainVerb, top) : undefined };
    }
    return { kind: 'read' };
  }

  if (READ.has(first)) {
    // SELECT ... INTO creates a table.
    return top.includes('INTO') && first === 'SELECT' ? { kind: 'ddl' } : { kind: 'read' };
  }
  if (WRITE.has(first)) return { kind: 'write', destructive: destructiveDml(first, top) };
  if (DDL.has(first)) {
    if (first === 'DROP') return { kind: 'ddl', destructive: `DROP ${top[1] ?? ''}`.trim() };
    if (first === 'TRUNCATE') return { kind: 'ddl', destructive: 'TRUNCATE removes every row' };
    if (first === 'ALTER' && top.includes('DROP'))
      return { kind: 'ddl', destructive: 'ALTER … DROP' };
    return { kind: 'ddl' };
  }
  if (SESSION.has(first)) {
    const unlocksWrites = readWriteSwitch(first, top);
    return unlocksWrites ? { kind: 'session', unlocksWrites } : { kind: 'session' };
  }
  return { kind: 'unknown' };
}

/** Statements that turn a read-only session or transaction read-write (the server re-checks). */
function readWriteSwitch(first: string, top: string[]): string | undefined {
  const readWrite = top.some((w, i) => w === 'READ' && top[i + 1] === 'WRITE');
  if ((first === 'BEGIN' || first === 'START') && readWrite) {
    return 'starts a read-write transaction';
  }
  if (first === 'SET') {
    if (top.includes('TRANSACTION') && readWrite) {
      return 'makes the transaction read-write';
    }
    if (top.includes('DEFAULT_TRANSACTION_READ_ONLY') || top.includes('TRANSACTION_READ_ONLY')) {
      return 'changes the read-only setting';
    }
  }
  return undefined;
}

function destructiveDml(verb: string, top: string[]): string | undefined {
  if ((verb === 'DELETE' || verb === 'UPDATE') && !top.includes('WHERE')) {
    return `${verb} without WHERE affects every row`;
  }
  return undefined;
}

/** Writes, DDL and unclassifiable statements: blocked on read-only sources, confirmed on production. */
export function modifies(c: Classification): boolean {
  return c.kind === 'write' || c.kind === 'ddl' || c.kind === 'unknown';
}

/** Everything a read-only source refuses: modifying statements and read-write switches. */
export function blockedOnReadOnly(c: Classification): boolean {
  return modifies(c) || c.unlocksWrites !== undefined;
}
