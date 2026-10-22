import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  VERSION_FILES,
  bumpVersion,
  decideBump,
  extractSection,
  parseCommit,
  prependSection,
  renderSection,
  setVersionIn,
} from './version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const commit = (subject, body = '') => parseCommit({ hash: 'abcdef1234567', subject, body });

test('parses the org commit form with a ticket', () => {
  assert.deepEqual(commit('feat:[KPDV2-2109] include inactive members export'), {
    hash: 'abcdef1234567',
    type: 'feat',
    ticket: 'KPDV2-2109',
    summary: 'include inactive members export',
    breaking: false,
  });
});

test('parses conventional commits with scope and breaking marker', () => {
  const parsed = commit('fix(grid)!: keep NULL distinct');
  assert.equal(parsed.type, 'fix');
  assert.equal(parsed.ticket, null);
  assert.equal(parsed.summary, 'keep NULL distinct');
  assert.equal(parsed.breaking, true);
  assert.equal(commit('feat: x', 'BREAKING CHANGE: removed y').breaking, true);
});

test('treats other subjects as "other" and skips release commits', () => {
  assert.equal(commit('M4.2: safe row editing').type, 'other');
  assert.equal(commit('chore: release v0.2.0 (#12)'), null);
});

test('decides the bump from commits', () => {
  assert.equal(decideBump([], '1.2.3'), null);
  assert.equal(decideBump([commit('M4.1: sort')], '1.2.3'), 'patch');
  assert.equal(decideBump([commit('fix: a'), commit('feat:[A-1] b')], '1.2.3'), 'minor');
  assert.equal(decideBump([commit('feat!: c')], '1.2.3'), 'major');
  assert.equal(decideBump([commit('feat!: c')], '0.4.0'), 'minor');
});

test('bumps versions', () => {
  assert.equal(bumpVersion('0.1.9', 'patch'), '0.1.10');
  assert.equal(bumpVersion('0.1.9', 'minor'), '0.2.0');
  assert.equal(bumpVersion('0.1.9', 'major'), '1.0.0');
  assert.throws(() => bumpVersion('1.0', 'patch'));
});

test('renders, prepends and extracts changelog sections', () => {
  const commits = [commit('feat:[A-1] add x'), commit('fix: y'), commit('M5: z')];
  const section = renderSection('0.2.0', commits, '2026-10-22');
  assert.match(section, /^## v0\.2\.0 \(2026-10-22\)/);
  assert.match(section, /### Features\n\n- add x \(A-1, abcdef1\)/);
  assert.match(section, /### Fixes\n\n- y \(abcdef1\)/);
  assert.match(section, /### Other changes\n\n- M5: z \(abcdef1\)/);

  const first = prependSection('', section);
  const second = prependSection(first, renderSection('0.3.0', [commit('fix: w')], '2026-11-01'));
  assert.ok(second.startsWith('# Changelog\n\n## v0.3.0'));
  assert.equal(extractSection(second, '0.3.0'), '### Fixes\n\n- w (abcdef1)\n');
  assert.match(extractSection(second, '0.2.0'), /add x/);
  assert.throws(() => extractSection(second, '9.9.9'));
});

test('finds the version in every real version file', () => {
  for (const { path, pattern } of VERSION_FILES) {
    const text = readFileSync(join(ROOT, path), 'utf8');
    const updated = setVersionIn(text, pattern, '9.8.7', path);
    assert.notEqual(updated, text, path);
    assert.equal(pattern.exec(updated)[2], '9.8.7', path);
    // Exactly one occurrence changes.
    assert.equal(updated.length, text.length + '9.8.7'.length - pattern.exec(text)[2].length, path);
  }
});
