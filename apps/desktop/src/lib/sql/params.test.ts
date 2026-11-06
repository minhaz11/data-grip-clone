import { describe, expect, it } from 'vitest';
import { bindParameters, findParameters, parameterNames } from './params';

const names = (sql: string) => findParameters(sql).map((p) => p.name);

describe('parameter detection', () => {
  it('finds :name, ${name} and $1', () => {
    expect(names('select * from t where id = :id and a = ${a} and b = $2')).toEqual([
      'id',
      'a',
      '2',
    ]);
    expect(names('select :id, :id')).toEqual(['id', 'id']);
  });

  it('skips strings, comments, quoted identifiers and dollar quotes', () => {
    expect(
      names("select ':no', E'\\':no', $$ :no $1 $$, $f$ :no $f$ -- :no\n/* :no $1 */"),
    ).toEqual([]);
    expect(names('select "a:no" from t')).toEqual([]);
    expect(names("select 'it''s :no' || :yes")).toEqual(['yes']);
  });

  it('skips casts, assignments, slices and identifiers with $', () => {
    expect(names("select '1'::int, x::text, a[1:2], arr[lo:hi], f(x := 1), a$1 from t")).toEqual(
      [],
    );
    expect(names('select (:a)::int')).toEqual(['a']);
  });

  it('leaves $n of PREPARE and function bodies alone', () => {
    expect(names('prepare p(int) as select $1')).toEqual([]);
    expect(names("create function f(int) returns int language sql as 'select $1 + :x'")).toEqual(
      [],
    );
    expect(names('create function f(int) returns int language sql as $$ select $1 $$')).toEqual([]);
  });

  it('collects distinct names across statements', () => {
    expect(parameterNames(['select :b, :a', 'select :a, $1'])).toEqual(['b', 'a', '1']);
  });
});

describe('binding', () => {
  it('numbers names after positional parameters and keeps values out of the text', () => {
    const bound = bindParameters('select $1, :name, ${n2}, :name, $2', {
      1: 'one',
      2: null,
      name: "x'; drop table t; --",
      n2: '42',
    });
    expect(bound.sql).toBe('select $1, $3   , $4   , $3   , $2');
    expect(bound.params).toEqual(['one', null, "x'; drop table t; --", '42']);
  });

  it('leaves statements without parameters as they are', () => {
    expect(bindParameters("select ':x'", {})).toEqual({ sql: "select ':x'", params: [] });
  });
});
