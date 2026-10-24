import { describe, expect, it } from 'vitest';
import {
  completionContextAt,
  maskLiterals,
  normalizeIdent,
  tablesInStatement,
} from './completionContext';
import { formatSql } from './format';
import { splitStatements, statementAt } from './statements';

const texts = (sql: string) => splitStatements(sql).map((s) => sql.slice(s.start, s.end));

describe('splitStatements', () => {
  it('splits on top-level semicolons only', () => {
    expect(texts('select 1; select \'a;b\'; select "x;y" from t -- c;\n; select 2')).toEqual([
      'select 1',
      "select 'a;b'",
      'select "x;y" from t -- c;',
      'select 2',
    ]);
  });

  it('handles dollar quotes, nested comments, E-strings and doubled quotes', () => {
    const fn = `create function f() returns int as $body$ begin return 1; end; $body$ language plpgsql`;
    expect(texts(`${fn}; select 2`)).toEqual([fn, 'select 2']);
    expect(texts('select $$a;b$$; select 3')).toEqual(['select $$a;b$$', 'select 3']);
    expect(texts('/* a /* nested; */ still; */ select 1; select 2')).toHaveLength(2);
    expect(texts("select E'it\\'s;'; select 'it''s;'")).toEqual([
      "select E'it\\'s;'",
      "select 'it''s;'",
    ]);
    expect(texts('select a$b; select 1')).toEqual(['select a$b', 'select 1']); // $ inside identifier
  });

  it('drops empty pieces and survives unterminated input', () => {
    expect(texts(' ;;  select 1 ;  ')).toEqual(['select 1']);
    expect(texts("select 'open")).toEqual(["select 'open"]);
    expect(texts('select $$open')).toEqual(['select $$open']);
  });
});

describe('statementAt', () => {
  const sql = 'select 1;\nselect 2;\n\nselect 3';
  it('finds the statement under the caret, preferring the one just ended', () => {
    expect(sql.slice(...span(statementAt(sql, 3)))).toBe('select 1');
    expect(sql.slice(...span(statementAt(sql, 9)))).toBe('select 1'); // right after ';'
    expect(sql.slice(...span(statementAt(sql, 12)))).toBe('select 2');
    expect(sql.slice(...span(statementAt(sql, 20)))).toBe('select 2'); // blank line after
    expect(sql.slice(...span(statementAt(sql, sql.length)))).toBe('select 3');
    expect(statementAt('   ', 1)).toBeNull();
  });
});

function span(s: { start: number; end: number } | null): [number, number] {
  if (!s) throw new Error('no statement');
  return [s.start, s.end];
}

describe('completion context', () => {
  const at = (sql: string) => completionContextAt(sql.replace('|', ''), sql.indexOf('|')).context;

  it('detects relations, members and general positions', () => {
    expect(at('select * from |')).toEqual({ kind: 'relations', word: '' });
    expect(at('select * from ord|')).toEqual({ kind: 'relations', word: 'ord' });
    expect(at('select * from a join |')).toEqual({ kind: 'relations', word: '', join: true });
    expect(at('select o.| from orders o')).toEqual({ kind: 'members', qualifier: 'o', word: '' });
    expect(at('select * from shop.cu|')).toEqual({
      kind: 'members',
      qualifier: 'shop',
      word: 'cu',
    });
    expect(at('select * from "My Schema".|')).toEqual({
      kind: 'members',
      qualifier: 'My Schema',
      word: '',
    });
    expect(at('select na|')).toEqual({ kind: 'general', word: 'na' });
    expect(at("select 'from |")).toEqual({ kind: 'general', word: '' }); // inside a string
  });

  it('resolves tables and aliases of the current statement', () => {
    expect(
      tablesInStatement(
        'select * from shop.orders o join customers as c on c.id = o.customer_id where 1=1',
      ),
    ).toEqual([
      { schema: 'shop', table: 'orders', alias: 'o' },
      { table: 'customers', alias: 'c' },
    ]);
    expect(tablesInStatement('update Accounts set x = 1')).toEqual([{ table: 'accounts' }]);
    expect(tablesInStatement('select * from "Odd ""T""" t')).toEqual([
      { table: 'Odd "T"', alias: 't' },
    ]);
    expect(tablesInStatement("select 'from fake' from real_t")).toEqual([{ table: 'real_t' }]);
  });

  it('normalizes identifiers and masks literals keeping offsets', () => {
    expect(normalizeIdent('Orders')).toBe('orders');
    expect(normalizeIdent('"Orders"')).toBe('Orders');
    const sql = "a 'x;y' -- z\nb";
    expect(maskLiterals(sql)).toHaveLength(sql.length);
    expect(maskLiterals(sql)).toBe('a' + ' '.repeat(11) + '\nb');
  });
});

describe('formatSql', () => {
  it('formats PostgreSQL and keeps keyword case', () => {
    expect(formatSql('select a,b from t where x=1')).toBe(
      'select\n  a,\n  b\nfrom\n  t\nwhere\n  x = 1',
    );
    expect(formatSql('SELECT $$a$$::text')).toContain('$$a$$::text');
  });
});
