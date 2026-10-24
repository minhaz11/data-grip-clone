import { describe, expect, it } from 'vitest';
import { ACTIONS, CONTEXT_LABELS } from './actions';
import { chordLabel, defaultKeymap } from './keymap';

/** `docs/keymap.md`, rendered from the action registry. Regenerate with `npm run keymap:doc`. */
const DOC = '../../../../docs/keymap.md';

function render(): string {
  const other = defaultKeymap('other');
  const mac = defaultKeymap('mac');
  const cell = (chords: string[], platform: 'mac' | 'other') =>
    chords.length ? chords.map((c) => `\`${chordLabel(c, platform)}\``).join(', ') : '-';
  const lines = [
    '# Keyboard shortcuts',
    '',
    '<!-- Generated from apps/desktop/src/lib/actions.ts by keymapDoc.test.ts. Do not edit. -->',
    '<!-- Regenerate with `npm run keymap:doc`. -->',
    '',
    'Default bindings of every action. Change them in Settings > Keymap: add a shortcut by pressing',
    'it, remove one, or reset an action or all of them. An action of the focused panel (SQL editor,',
    'result grid, Database Explorer) wins over an "Everywhere" action with the same shortcut, and',
    'conflicts are shown before saving.',
    '',
    'Arrow keys, Page Up/Down and Home/End move within lists, trees and the grid, and Enter, Tab and',
    'Escape work as usual in dialogs and cell editors; these are not rebindable.',
    '',
    'On macOS, `⌘` is Command and `⌃` is Control. Some defaults differ there because the system',
    'owns the usual chord (Command-Q quits, Command-Tab switches apps, Option-arrows move by word).',
    'These chords cannot be bound: on macOS `⌘Q`, `⌘H`, `⌥⌘H`, `⌘M`, `⌘Tab`, `⌘Space` and',
    '`⇧⌘3`/`4`/`5`; on Windows and Linux `Alt+F4`, `Alt+Tab` and `Ctrl+Alt+Delete`. Where text is',
    'typed (everywhere and in the SQL editor), a shortcut without Ctrl or Alt must be a function key.',
    '',
    '| Action | Where | Windows and Linux | macOS |',
    '| ------ | ----- | ----------------- | ----- |',
    ...ACTIONS.map(
      (a) =>
        `| ${a.title} | ${CONTEXT_LABELS[a.context]} | ${cell(other[a.id], 'other')} | ${cell(mac[a.id], 'mac')} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

describe('keymap documentation', () => {
  it('docs/keymap.md matches the action registry', async () => {
    await expect(render()).toMatchFileSnapshot(DOC);
  });
});
