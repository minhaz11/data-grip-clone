/** One line of a line-by-line comparison. */
export interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
  /** Line number in the old text (for `same` and `removed`). */
  oldLine?: number;
  /** Line number in the new text (for `same` and `added`). */
  newLine?: number;
}

/** Above this many cells (old lines times new lines) the comparison is not attempted. */
export const MAX_DIFF_CELLS = 4_000_000;

/**
 * Line diff of `before` to `after` by longest common subsequence, with the common start and end
 * trimmed first so typical edits stay cheap. `null` when the texts are too large to compare.
 */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_DIFF_CELLS) {
    return null;
  }
  // lcs[i][j]: common lines of a[start+i..endA] and b[start+j..endB].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const below = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        a[start + i] === b[start + j]
          ? (below[j + 1] ?? 0) + 1
          : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  for (let k = 0; k < start; k++) {
    out.push({ kind: 'same', text: a[k] ?? '', oldLine: k + 1, newLine: k + 1 });
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const ai = a[start + i];
    const bj = b[start + j];
    if (i < n && j < m && ai === bj) {
      out.push({ kind: 'same', text: ai ?? '', oldLine: start + i + 1, newLine: start + j + 1 });
      i++;
      j++;
    } else if (j < m && (i === n || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      out.push({ kind: 'added', text: bj ?? '', newLine: start + j + 1 });
      j++;
    } else {
      out.push({ kind: 'removed', text: ai ?? '', oldLine: start + i + 1 });
      i++;
    }
  }
  for (let k = 0; k < a.length - endA; k++) {
    out.push({
      kind: 'same',
      text: a[endA + k] ?? '',
      oldLine: endA + k + 1,
      newLine: endB + k + 1,
    });
  }
  return out;
}
