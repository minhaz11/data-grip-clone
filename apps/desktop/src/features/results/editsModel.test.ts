import { describe, expect, it } from 'vitest';
import type { EditTarget } from '../../ipc/types';
import {
  addInsert,
  cloneRows,
  NO_EDITS,
  pendingCount,
  removeInsert,
  revertRows,
  rowKey,
  setCell,
  setDefault,
  setInsert,
  toChanges,
  toggleDelete,
  unsetInsert,
} from './editsModel';

const T: EditTarget = {
  schema: 'shop',
  table: 'customers',
  columns: [{ name: 'id', typeName: 'int4' }, { name: 'email', typeName: 'text' }, null],
  key: [0],
};
const row1 = ['1', 'a@x.test', 'computed'];
const row2 = ['2', null, 'computed'];

describe('pending edits', () => {
  it('tracks cell changes with originals and drops no-op edits', () => {
    let e = setCell(NO_EDITS, T, row1, 1, 'new@x.test');
    e = setCell(e, T, row1, 1, 'newer@x.test');
    expect(toChanges(e)).toEqual([
      {
        kind: 'update',
        key: ['1'],
        set: [{ column: 1, value: 'newer@x.test' }],
        original: [{ column: 1, value: 'a@x.test' }],
        defaults: [],
      },
    ]);
    expect(setCell(e, T, row1, 1, 'a@x.test')).toEqual(NO_EDITS); // back to the original
    expect(setCell(NO_EDITS, T, row1, 2, 'x')).toEqual(NO_EDITS); // non-editable column
    const nulled = setCell(NO_EDITS, T, row2, 1, 'set');
    expect(toChanges(nulled)[0]).toMatchObject({ original: [{ column: 1, value: null }] });
  });

  it('deletes win over updates and toggle back', () => {
    let e = setCell(NO_EDITS, T, row1, 1, 'x');
    e = toggleDelete(e, T, row1);
    expect(toChanges(e)).toEqual([{ kind: 'delete', key: ['1'] }]);
    expect(pendingCount(e)).toBe(1);
    e = toggleDelete(e, T, row1);
    expect(toChanges(e).map((c) => c.kind)).toEqual(['update']);
  });

  it('inserts carry only the columns that were set', () => {
    let e = addInsert(NO_EDITS, 'n1');
    e = addInsert(e, 'n2');
    e = setInsert(e, 'n1', 1, 'new@x.test');
    e = removeInsert(e, 'n2');
    expect(toChanges(e)).toEqual([
      { kind: 'insert', values: [{ column: 1, value: 'new@x.test' }] },
    ]);
  });

  it('orders changes deterministically and needs identifiable rows', () => {
    let e = addInsert(NO_EDITS, 'n1');
    e = toggleDelete(e, T, row2);
    e = setCell(e, T, row1, 1, 'x');
    expect(toChanges(e).map((c) => c.kind)).toEqual(['update', 'delete', 'insert']);
    expect(rowKey(T, [null, 'x', 'y'])).toBeNull();
    expect(rowKey(T, undefined)).toBeNull();
    expect(setCell(NO_EDITS, T, [null, 'x', 'y'], 1, 'z')).toEqual(NO_EDITS);
  });

  it('sets existing cells to DEFAULT with the original for the optimistic check', () => {
    let e = setCell(NO_EDITS, T, row1, 1, 'typed');
    e = setDefault(e, T, row1, 1);
    expect(toChanges(e)).toEqual([
      {
        kind: 'update',
        key: ['1'],
        set: [],
        original: [{ column: 1, value: 'a@x.test' }],
        defaults: [1],
      },
    ]);
    expect(pendingCount(e)).toBe(1);
    // Typing a value replaces DEFAULT; typing the original again drops the change.
    expect(toChanges(setCell(e, T, row1, 1, 'v'))[0]).toMatchObject({
      set: [{ column: 1, value: 'v' }],
      defaults: [],
    });
    expect(setCell(e, T, row1, 1, 'a@x.test')).toEqual(NO_EDITS);
    expect(setDefault(NO_EDITS, T, row1, 2)).toEqual(NO_EDITS); // non-editable column
  });

  it('reverts and clones selected rows', () => {
    let e = setCell(NO_EDITS, T, row1, 1, 'x');
    e = toggleDelete(e, T, row2);
    e = addInsert(e, 'n1');
    e = setInsert(e, 'n1', 1, 'new');
    expect(unsetInsert(e, 'n1', 1).inserts[0]?.values).toEqual({});
    const reverted = revertRows(e, T, [row1], ['n1']);
    expect(toChanges(reverted)).toEqual([{ kind: 'delete', key: ['2'] }]);
    expect(revertRows(reverted, T, [row2], [])).toEqual(NO_EDITS);

    const cloned = cloneRows(NO_EDITS, T, [row1, row2], (n) => `c${n}`);
    // The key column and non-editable columns are left out.
    expect(cloned.inserts).toEqual([
      { id: 'c0', values: { 1: 'a@x.test' } },
      { id: 'c1', values: { 1: null } },
    ]);
  });
});
