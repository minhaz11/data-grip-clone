import { describe, expect, it } from 'vitest';
import { nextSort } from './refineModel';

describe('nextSort', () => {
  it('plain clicks cycle one column asc → desc → off and replace other keys', () => {
    expect(nextSort([], 2, false)).toEqual([{ column: 2, descending: false }]);
    expect(nextSort([{ column: 2, descending: false }], 2, false)).toEqual([
      { column: 2, descending: true },
    ]);
    expect(nextSort([{ column: 2, descending: true }], 2, false)).toEqual([]);
    expect(
      nextSort(
        [
          { column: 0, descending: true },
          { column: 2, descending: false },
        ],
        2,
        false,
      ),
    ).toEqual([{ column: 2, descending: false }]);
  });

  it('shift clicks add keys and cycle them in place', () => {
    const one = [{ column: 0, descending: false }];
    expect(nextSort(one, 3, true)).toEqual([
      { column: 0, descending: false },
      { column: 3, descending: false },
    ]);
    const two = [
      { column: 0, descending: false },
      { column: 3, descending: false },
    ];
    expect(nextSort(two, 3, true)).toEqual([
      { column: 0, descending: false },
      { column: 3, descending: true },
    ]);
    expect(
      nextSort(
        [
          { column: 0, descending: false },
          { column: 3, descending: true },
        ],
        3,
        true,
      ),
    ).toEqual(one);
  });
});
