import { describe, expect, it } from 'vitest';
import { blockedOnReadOnly, classify, modifies } from './classify';

describe('classify', () => {
  it.each([
    ['select * from t', 'read'],
    ['  -- comment\n SELECT 1', 'read'],
    ['values (1), (2)', 'read'],
    ['show search_path', 'read'],
    ['explain select * from t', 'read'],
    ['insert into t values (1)', 'write'],
    ['update t set a = 1 where id = 2', 'write'],
    ['copy t from stdin', 'write'],
    ['create table t (id int)', 'ddl'],
    ['select * into backup from t', 'ddl'],
    ['vacuum analyze t', 'ddl'],
    ['begin', 'session'],
    ['set search_path = shop', 'session'],
    ['with x as (select 1) select * from x', 'read'],
    ['with gone as (delete from t returning *) select count(*) from gone', 'write'],
    ['frobnicate everything', 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (sql, kind) => {
    expect(classify(sql).kind).toBe(kind);
  });

  it('treats EXPLAIN ANALYZE as running its statement', () => {
    expect(classify('explain analyze delete from t').kind).toBe('write');
    expect(classify('explain (analyze, buffers) update t set a = 1').destructive).toContain(
      'UPDATE without WHERE',
    );
    expect(classify('explain (analyze false) delete from t').kind).toBe('read');
    expect(classify('explain analyze select 1').kind).toBe('read');
  });

  it('flags destructive statements with a reason', () => {
    expect(classify('drop table orders').destructive).toBe('DROP TABLE');
    expect(classify('truncate orders').destructive).toMatch(/every row/);
    expect(classify('alter table t drop column c').destructive).toBe('ALTER … DROP');
    expect(classify('delete from t').destructive).toMatch(/DELETE without WHERE/);
    expect(classify('update t set a = 1').destructive).toMatch(/UPDATE without WHERE/);
    expect(classify('delete from t where id = 1').destructive).toBeUndefined();
    // WHERE inside a subquery does not make the outer UPDATE safe.
    expect(classify('update t set a = (select 1 from u where u.id = 2)').destructive).toMatch(
      /UPDATE without WHERE/,
    );
    expect(classify('alter table t add column c int').destructive).toBeUndefined();
  });

  it('ignores keywords inside strings, comments and quoted identifiers', () => {
    expect(classify("select 'drop table x; delete from y'").kind).toBe('read');
    expect(classify('select 1 -- delete from t').kind).toBe('read');
    expect(classify('select "delete" from t').kind).toBe('read');
    expect(classify("delete from t where note = 'x'").destructive).toBeUndefined();
  });

  it('modifies() covers writes, DDL and unknowns', () => {
    expect(
      ['select 1', 'begin', 'insert into t values (1)', 'drop table t', '???'].map((s) =>
        modifies(classify(s)),
      ),
    ).toEqual([false, false, true, true, true]);
  });

  it.each([
    ['begin read write', 'starts a read-write transaction'],
    [
      'START TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ WRITE',
      'starts a read-write transaction',
    ],
    ['set transaction read write', 'makes the transaction read-write'],
    ['set session characteristics as transaction read write', 'makes the transaction read-write'],
    ['set default_transaction_read_only = off', 'changes the read-only setting'],
    ["SET LOCAL transaction_read_only TO 'off'", 'changes the read-only setting'],
  ])('flags %s as unlocking writes on read-only sources', (sql, reason) => {
    const c = classify(sql);
    expect(c.kind).toBe('session');
    expect(c.unlocksWrites).toBe(reason);
    expect(modifies(c)).toBe(false);
    expect(blockedOnReadOnly(c)).toBe(true);
  });

  it.each(['begin', 'begin read only', 'set search_path = shop', 'reset all', 'commit'])(
    'leaves %s runnable on read-only sources',
    (sql) => {
      expect(blockedOnReadOnly(classify(sql))).toBe(false);
    },
  );
});
