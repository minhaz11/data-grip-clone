import { format } from 'sql-formatter';

/** Formats PostgreSQL text. Keeps the user's keyword case; throws with a readable message on parse errors. */
export function formatSql(sql: string): string {
  try {
    return format(sql, {
      language: 'postgresql',
      tabWidth: 2,
      keywordCase: 'preserve',
      linesBetweenQueries: 1,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message.split('\n')[0] : String(e);
    throw new Error(`Could not format: ${detail}`, { cause: e });
  }
}
