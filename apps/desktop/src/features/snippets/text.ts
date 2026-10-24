/**
 * Monaco snippet syntax to plain text: `${1:name}` becomes `name`, `$1`, `${1}` and `$0` become
 * empty, `\$` is a literal `$` (dollar quotes, `$1` parameters), `\}` and `\\` are literal too.
 * Variables (`$CURRENT_YEAR`, `${TM_SELECTED_TEXT}`) are left out. Returns the text and where each
 * tab stop is, in order (`$0` last), for editors without Monaco's snippet support.
 */
export function snippetText(body: string): {
  text: string;
  stops: { start: number; end: number }[];
} {
  let text = '';
  const stops: { index: number; start: number; end: number }[] = [];
  let i = 0;
  const parse = (until: string | null) => {
    while (i < body.length) {
      const c = body[i] as string;
      if (until !== null && c === until) {
        i++;
        return;
      }
      if (c === '\\' && i + 1 < body.length && '$}\\'.includes(body[i + 1] as string)) {
        text += body[i + 1];
        i += 2;
        continue;
      }
      if (c === '$') {
        const simple = /^\$(\d+)/.exec(body.slice(i));
        if (simple?.[1]) {
          stops.push({ index: Number(simple[1]), start: text.length, end: text.length });
          i += simple[0].length;
          continue;
        }
        const placeholder = /^\$\{(\d+)(:|\})/.exec(body.slice(i));
        if (placeholder?.[1]) {
          i += placeholder[0].length;
          const start = text.length;
          if (placeholder[2] === ':') {
            parse('}');
          }
          stops.push({ index: Number(placeholder[1]), start, end: text.length });
          continue;
        }
        const variable = /^\$(\{[A-Za-z_]+(:[^}]*)?\}|[A-Za-z_]+)/.exec(body.slice(i));
        if (variable) {
          i += variable[0].length;
          continue;
        }
      }
      text += c;
      i++;
    }
  };
  parse(null);
  // Tab order: 1, 2, ... then 0 (the final position).
  const ordered = stops
    .sort((a, b) => (a.index === 0 ? 1 : 0) - (b.index === 0 ? 1 : 0) || a.index - b.index)
    .map(({ start, end }) => ({ start, end }));
  return { text, stops: ordered };
}

/** Escapes text so Monaco inserts it literally (for building snippet bodies from SQL). */
export function escapeSnippet(sql: string): string {
  return sql.replace(/[\\$}]/g, (c) => `\\${c}`);
}
