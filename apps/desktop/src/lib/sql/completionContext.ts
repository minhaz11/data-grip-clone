import { statementAt } from './statements';

export interface TableRef {
  schema?: string;
  table: string;
  alias?: string;
}

export type CompletionContext =
  | { kind: 'members'; qualifier: string; word: string }
  | { kind: 'relations'; word: string }
  | { kind: 'general'; word: string };

const RELATION_KEYWORDS = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE']);
// Words that can follow a table reference and must not be taken for an alias.
const NOT_ALIAS = new Set(
  'WHERE JOIN ON INNER LEFT RIGHT FULL CROSS NATURAL GROUP ORDER LIMIT OFFSET SET VALUES USING UNION INTERSECT EXCEPT RETURNING HAVING WINDOW FOR AS LATERAL TABLESAMPLE'.split(
    ' ',
  ),
);

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;

/** Removes quotes from an identifier and folds unquoted ones to lower case (PostgreSQL rules). */
export function normalizeIdent(raw: string): string {
  return raw.startsWith('"') ? raw.slice(1, -1).replace(/""/g, '"') : raw.toLowerCase();
}

/** Blanks out strings and comments (same length) so regexes only see code. */
export function maskLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g, (m) =>
    ' '.repeat(m.length),
  );
}

/** Tables referenced after FROM/JOIN/UPDATE/INTO in one statement, with optional aliases. */
export function tablesInStatement(statement: string): TableRef[] {
  const code = maskLiterals(statement);
  const re = new RegExp(
    String.raw`\b(?:from|join|update|into)\s+(${IDENT})(?:\s*\.\s*(${IDENT}))?(?:\s+(?:as\s+)?(${IDENT}))?`,
    'gi',
  );
  const refs: TableRef[] = [];
  for (const m of code.matchAll(re)) {
    const [first, second, alias] = [m[1], m[2], m[3]];
    if (!first) continue;
    const ref: TableRef = second
      ? { schema: normalizeIdent(first), table: normalizeIdent(second) }
      : { table: normalizeIdent(first) };
    if (alias && !NOT_ALIAS.has(alias.toUpperCase())) ref.alias = normalizeIdent(alias);
    refs.push(ref);
  }
  return refs;
}

/** What is being completed at `offset`, plus the statement it sits in. */
export function completionContextAt(
  text: string,
  offset: number,
): { context: CompletionContext; statement: string } {
  const span = statementAt(text, offset);
  const statement = span ? text.slice(span.start, Math.max(span.end, offset)) : '';
  const before = maskLiterals(text.slice(span?.start ?? 0, offset));

  const word = /[\w$]*$/.exec(before)?.[0] ?? '';
  const head = before.slice(0, before.length - word.length);
  const qualified = new RegExp(String.raw`(${IDENT})\s*\.\s*$`).exec(head);
  if (qualified?.[1])
    return {
      context: { kind: 'members', qualifier: normalizeIdent(qualified[1]), word },
      statement,
    };

  const previous = /([A-Za-z_]+)\s*$/.exec(head)?.[1]?.toUpperCase();
  if (previous && RELATION_KEYWORDS.has(previous))
    return { context: { kind: 'relations', word }, statement };
  return { context: { kind: 'general', word }, statement };
}
