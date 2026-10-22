#!/usr/bin/env node
// Release versioning: decides the next version from commit messages, writes it into every file
// that carries the app version, and maintains CHANGELOG.md. Used by the release workflows.
//
//   node scripts/release/version.mjs current
//   node scripts/release/version.mjs prepare [--bump auto|patch|minor|major]
//   node scripts/release/version.mjs notes <version>

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHANGELOG = 'CHANGELOG.md';
const CHANGELOG_HEADER = '# Changelog\n';
const BUMPS = ['auto', 'patch', 'minor', 'major'];
const VERSION_RE = /^\d+\.\d+\.\d+$/;

// `feat: x`, `feat(scope)!: x`, and the org form `feat:[KPDV2-2109] x`.
const HEADER_RE =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?:\[(?<ticket>[A-Z][A-Z0-9]*-\d+)\]\s*)?(?<summary>\S.*)$/;
const BREAKING_RE = /^BREAKING[ -]CHANGE:/m;
const RELEASE_COMMIT_RE = /^chore(?:\(release\))?: release v?\d+\.\d+\.\d+/;

/** Files that carry the app version, each with the one place the version is written. */
export const VERSION_FILES = [
  { path: 'apps/desktop/src-tauri/tauri.conf.json', pattern: /("version"\s*:\s*")([^"]+)(")/ },
  { path: 'apps/desktop/package.json', pattern: /("version"\s*:\s*")([^"]+)(")/ },
  { path: 'apps/desktop/src-tauri/Cargo.toml', pattern: /^(version = ")([^"]+)(")/m },
  { path: 'Cargo.lock', pattern: /(name = "quarry-desktop"\nversion = ")([^"]+)(")/ },
  {
    path: 'package-lock.json',
    pattern: /("apps\/desktop": \{\s*"name": "@quarry\/desktop",\s*"version": ")([^"]+)(")/,
  },
];

export function parseCommit({ hash, subject, body = '' }) {
  if (RELEASE_COMMIT_RE.test(subject)) {
    return null;
  }
  const match = HEADER_RE.exec(subject);
  const breaking = Boolean(match?.groups.bang) || BREAKING_RE.test(body);
  if (!match) {
    return { hash, type: 'other', ticket: null, summary: subject, breaking };
  }
  const { type, ticket, summary } = match.groups;
  return { hash, type, ticket: ticket ?? null, summary, breaking };
}

/** feat -> minor, anything else -> patch, breaking -> major (minor while the major is 0). */
export function decideBump(commits, currentVersion) {
  if (commits.length === 0) {
    return null;
  }
  if (commits.some((c) => c.breaking)) {
    return parseVersion(currentVersion).major === 0 ? 'minor' : 'major';
  }
  if (commits.some((c) => c.type === 'feat')) {
    return 'minor';
  }
  return 'patch';
}

export function parseVersion(version) {
  if (!VERSION_RE.test(version)) {
    throw new Error(`Not a MAJOR.MINOR.PATCH version: "${version}"`);
  }
  const [major, minor, patch] = version.split('.').map(Number);
  return { major, minor, patch };
}

export function bumpVersion(version, bump) {
  const { major, minor, patch } = parseVersion(version);
  if (bump === 'major') {
    return `${major + 1}.0.0`;
  }
  if (bump === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  if (bump === 'patch') {
    return `${major}.${minor}.${patch + 1}`;
  }
  throw new Error(`Unknown bump "${bump}"`);
}

export function renderSection(version, commits, date) {
  const groups = [
    { title: 'Breaking changes', items: commits.filter((c) => c.breaking) },
    { title: 'Features', items: commits.filter((c) => !c.breaking && c.type === 'feat') },
    { title: 'Fixes', items: commits.filter((c) => !c.breaking && c.type === 'fix') },
    {
      title: 'Other changes',
      items: commits.filter((c) => !c.breaking && c.type !== 'feat' && c.type !== 'fix'),
    },
  ];
  const lines = [`## v${version} (${date})`, ''];
  for (const group of groups) {
    if (group.items.length === 0) {
      continue;
    }
    lines.push(`### ${group.title}`, '');
    for (const c of group.items) {
      const refs = [c.ticket, c.hash.slice(0, 7)].filter(Boolean).join(', ');
      lines.push(`- ${c.summary} (${refs})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function prependSection(changelog, section) {
  const body = changelog.startsWith(CHANGELOG_HEADER)
    ? changelog.slice(CHANGELOG_HEADER.length).replace(/^\n+/, '')
    : changelog;
  return `${CHANGELOG_HEADER}\n${section}\n${body}`.replace(/\n+$/, '\n');
}

export function extractSection(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## v${version} `) || l === `## v${version}`);
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no section for v${version}`);
  }
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) {
    end = lines.length;
  }
  return `${lines
    .slice(start + 1, end)
    .join('\n')
    .trim()}\n`;
}

export function setVersionIn(text, pattern, version, path) {
  if (!pattern.test(text)) {
    throw new Error(`Could not find the version in ${path}`);
  }
  return text.replace(pattern, `$1${version}$3`);
}

function readCurrentVersion() {
  const { path, pattern } = VERSION_FILES[0];
  const match = pattern.exec(readFileSync(join(ROOT, path), 'utf8'));
  if (!match) {
    throw new Error(`Could not find the version in ${path}`);
  }
  return match[2];
}

function git(args, stderr = 'inherit') {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', stderr],
  });
}

function lastReleaseTag() {
  try {
    // Fails with "No names found" before the first release; that is expected, not an error.
    return git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], 'ignore').trim();
  } catch {
    return null;
  }
}

function commitsSince(tag) {
  const range = tag ? [`${tag}..HEAD`] : ['HEAD'];
  const raw = git(['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', ...range]);
  return raw
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, subject, body] = record.split('\x1f');
      return parseCommit({ hash, subject, body });
    })
    .filter(Boolean);
}

function writeOutputs(outputs) {
  const file = process.env.GITHUB_OUTPUT;
  const text = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join('');
  if (file) {
    appendFileSync(file, text);
  }
  process.stdout.write(text);
}

function prepare(bumpArg) {
  if (!BUMPS.includes(bumpArg)) {
    throw new Error(`--bump must be one of ${BUMPS.join(', ')}`);
  }
  const current = readCurrentVersion();
  const tag = lastReleaseTag();
  const commits = commitsSince(tag);

  let next;
  if (!tag) {
    // First release: ship the version already in the files.
    next = current;
  } else {
    const bump = bumpArg === 'auto' ? decideBump(commits, current) : bumpArg;
    if (!bump) {
      writeOutputs({ release: 'false' });
      return;
    }
    next = bumpVersion(current, bump);
  }

  for (const { path, pattern } of VERSION_FILES) {
    const full = join(ROOT, path);
    writeFileSync(full, setVersionIn(readFileSync(full, 'utf8'), pattern, next, path));
  }

  const date = new Date().toISOString().slice(0, 10);
  const section = renderSection(next, commits, date);
  const changelogPath = join(ROOT, CHANGELOG);
  const existing = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
  writeFileSync(changelogPath, prependSection(existing, section));

  const notesFile = join(process.env.RUNNER_TEMP ?? tmpdir(), `release-notes-v${next}.md`);
  writeFileSync(notesFile, extractSection(readFileSync(changelogPath, 'utf8'), next));
  writeOutputs({ release: 'true', version: next, previous: current, notes_file: notesFile });
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'current') {
    process.stdout.write(`${readCurrentVersion()}\n`);
    return;
  }
  if (command === 'prepare') {
    const flag = rest.indexOf('--bump');
    prepare(flag === -1 ? 'auto' : (rest[flag + 1] ?? ''));
    return;
  }
  if (command === 'notes') {
    const version = rest[0] ?? readCurrentVersion();
    process.stdout.write(extractSection(readFileSync(join(ROOT, CHANGELOG), 'utf8'), version));
    return;
  }
  throw new Error(
    'Usage: version.mjs current | prepare [--bump auto|patch|minor|major] | notes <version>',
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
