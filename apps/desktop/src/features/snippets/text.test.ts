import { describe, expect, it } from 'vitest';
import { BUILTIN_SNIPPETS } from './builtins';
import { escapeSnippet, snippetText } from './text';

describe('snippet bodies', () => {
  it('turns placeholders into their text and records tab stops in order, $0 last', () => {
    const { text, stops } = snippetText('SELECT ${1:*} FROM ${2:t}$0 -- ${3}');
    expect(text).toBe('SELECT * FROM t -- ');
    expect(stops.map((s) => text.slice(s.start, s.end))).toEqual(['*', 't', '', '']);
    expect(stops[3]).toEqual({ start: 15, end: 15 });
  });

  it('keeps dollar quotes and $1 parameters written as \\$', () => {
    const fn = BUILTIN_SNIPPETS.find((s) => s.abbreviation === 'fn');
    const { text } = snippetText(fn?.body ?? '');
    expect(text).toContain('LANGUAGE plpgsql AS $$');
    expect(text).toContain('RETURN $1;');
    expect(text.trimEnd().endsWith('$$;')).toBe(true);
    expect(snippetText('select \\$1, \\\\ and \\}').text).toBe('select $1, \\ and }');
  });

  it('nests placeholders and drops variables', () => {
    expect(snippetText('a${1:b ${2:c}}d').text).toBe('ab cd');
    expect(snippetText('-- $CURRENT_YEAR ${TM_SELECTED_TEXT}x').text).toBe('--  x');
  });

  it('escapes SQL so it is inserted literally', () => {
    const sql = "select $1 from t where body = $$a}b$$ and x = '\\'";
    expect(snippetText(escapeSnippet(sql)).text).toBe(sql);
  });

  it('every built-in has a unique abbreviation and parses', () => {
    const names = BUILTIN_SNIPPETS.map((s) => s.abbreviation);
    expect(new Set(names).size).toBe(names.length);
    for (const s of BUILTIN_SNIPPETS) {
      expect(snippetText(s.body).text).not.toMatch(/\$\{/);
    }
  });
});
