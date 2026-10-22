import { describe, expect, it } from 'vitest';
import type { EditTarget } from '../../ipc/types';
import {
  addInsert,
  NO_EDITS,
  pendingCount,
  removeInsert,
  rowKey,
  setCell,
  setInsert,
  toChanges,
  toggleDelete,
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
});
