import { describe, expect, it } from 'vitest';
import { diffLines } from './diff';

const kinds = (before: string, after: string) =>
  diffLines(before, after)?.map((l) => `${l.kind[0]} ${l.text}`);

describe('diffLines', () => {
  it('marks added, removed and kept lines in order', () => {
    expect(kinds('a\nb\nc', 'a\nB\nc\nd')).toEqual(['s a', 'a B', 'r b', 's c', 'a d']);
    expect(kinds('select 1', '')).toEqual(['a ', 'r select 1']);
    expect(kinds('x', 'x')).toEqual(['s x']);
  });

  it('numbers lines on both sides', () => {
    const lines = diffLines('a\nb\nc', 'a\nc') ?? [];
    expect(lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['same', 1, 1],
      ['removed', 2, undefined],
      ['same', 3, 2],
    ]);
  });

  it('gives up on texts too large to compare', () => {
    const big = (p: string) => Array.from({ length: 3000 }, (_, i) => `${p}${i}`).join('\n');
    expect(diffLines(big('a'), big('b'))).toBeNull();
    // A small change in a large text is cheap: the common start and end are skipped.
    const text = big('x');
    expect(diffLines(text, `${text}\nmore`)?.filter((l) => l.kind !== 'same')).toHaveLength(1);
  });
});
