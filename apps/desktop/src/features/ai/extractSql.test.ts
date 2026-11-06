import { describe, expect, it } from 'vitest';
import { extractSql } from './extractSql';

describe('extractSql', () => {
  it('takes the first sql block', () => {
    const answer = [
      'Here you go:',
      '```sql',
      'SELECT id',
      'FROM orders;',
      '```',
      'And an alternative:',
      '```sql',
      'SELECT 2;',
      '```',
    ].join('\n');
    expect(extractSql(answer)).toBe('SELECT id\nFROM orders;');
  });

  it('accepts other PostgreSQL tags and tildes', () => {
    expect(extractSql('~~~postgresql\nselect 1;\n~~~')).toBe('select 1;');
    expect(extractSql('```PGSQL\nselect 1;\n```')).toBe('select 1;');
  });

  it('prefers a tagged block over an untagged one', () => {
    expect(extractSql('```\nnot sql at all\n```\n```sql\nselect 3;\n```')).toBe('select 3;');
  });

  it('uses an untagged block that reads as SQL', () => {
    expect(extractSql('Try:\n```\nUPDATE t SET a = 1 WHERE id = 2;\n```')).toBe(
      'UPDATE t SET a = 1 WHERE id = 2;',
    );
    expect(extractSql('```\nnpm install\n```')).toBeNull();
  });

  it('skips blocks in other languages', () => {
    expect(extractSql('```python\nprint(1)\n```\nNo SQL needed.')).toBeNull();
  });

  it('keeps dollar quotes and placeholders as written', () => {
    const body = 'CREATE FUNCTION f() RETURNS int AS $$ SELECT $1 + 1 $$ LANGUAGE sql;';
    expect(extractSql('```sql\n' + body + '\n```')).toBe(body);
  });

  it('takes an answer cut off inside a block', () => {
    expect(extractSql('```sql\nSELECT a,\n  b\nFROM')).toBe('SELECT a,\n  b\nFROM');
  });

  it('takes a bare answer that is only SQL', () => {
    expect(extractSql('select count(*) from orders;')).toBe('select count(*) from orders;');
    expect(extractSql('SELECT 1')).toBe('SELECT 1');
  });

  it('finds nothing in prose', () => {
    expect(extractSql('Select the right index first, then try again.\nIt helps.')).toBeNull();
    expect(extractSql('The error means the column does not exist.')).toBeNull();
    expect(extractSql('')).toBeNull();
  });
});
