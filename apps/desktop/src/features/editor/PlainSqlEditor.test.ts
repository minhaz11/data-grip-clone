import { describe, expect, it } from 'vitest';
import { caretPosition } from './PlainSqlEditor';

describe('caretPosition', () => {
  it('reports 1-based line and column', () => {
    expect(caretPosition('', 0)).toEqual({ line: 1, column: 1 });
    expect(caretPosition('select 1;', 6)).toEqual({ line: 1, column: 7 });
    expect(caretPosition('select\n  1;', 9)).toEqual({ line: 2, column: 3 });
  });
});
