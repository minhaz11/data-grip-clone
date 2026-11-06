const SQL_FENCE_LANGS = new Set(['sql', 'postgresql', 'postgres', 'pgsql', 'psql', 'plpgsql']);

/** Statement keywords an answer made only of SQL starts with. */
const SQL_START =
  /^(?:select|with|insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|explain|analyze|vacuum|begin|commit|rollback|set|show|copy|comment|do|call|values|table|refresh|reindex|cluster|lock)\b/i;

interface Fence {
  lang: string;
  body: string;
}

/** Fenced code blocks in order; an unclosed last fence (a cut-off answer) runs to the end. */
function fences(text: string): Fence[] {
  const out: Fence[] = [];
  const re = /^[ \t]*(`{3,}|~{3,})[ \t]*([\w+-]*)[^\n]*\n/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const marker = m[1] ?? '```';
    const lang = (m[2] ?? '').toLowerCase();
    const start = m.index + m[0].length;
    const close = new RegExp(
      `^[ \\t]*${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`,
      'm',
    );
    const rest = text.slice(start);
    const end = rest.search(close);
    const body = end === -1 ? rest : rest.slice(0, end);
    out.push({ lang, body: body.replace(/\n$/, '') });
    if (end === -1) {
      break;
    }
    re.lastIndex = start + end + (rest.slice(end).match(/^[^\n]*\n?/)?.[0].length ?? 0);
  }
  return out;
}

/**
 * The SQL in an AI answer: the first ```sql block (or a block tagged as PostgreSQL), else the
 * first untagged block that reads as SQL, else the whole answer when it is nothing but SQL.
 * `null` when the answer holds no SQL.
 */
export function extractSql(answer: string): string | null {
  const blocks = fences(answer);
  const tagged = blocks.find((b) => SQL_FENCE_LANGS.has(b.lang) && b.body.trim());
  if (tagged) {
    return tagged.body.trim();
  }
  const plain = blocks.find((b) => !b.lang && SQL_START.test(b.body.trim()));
  if (plain) {
    return plain.body.trim();
  }
  const whole = answer.trim();
  if (blocks.length === 0 && SQL_START.test(whole) && /;\s*$|^[^\n]*$/.test(whole)) {
    return whole;
  }
  return null;
}
