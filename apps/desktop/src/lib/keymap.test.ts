import { describe, expect, it } from 'vitest';
import { ACTIONS } from './actions';
import {
  chordLabel,
  chordOf,
  conflicts,
  contextOf,
  defaultKeymap,
  effectiveKeymap,
  resolveAction,
  shortcutLabel,
  unbindableReason,
} from './keymap';

const ev = (
  key: string,
  code: string,
  mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {},
) => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('chords', () => {
  it('normalizes chords using physical keys', () => {
    expect(chordOf(ev('Q', 'KeyQ', { ctrlKey: true, shiftKey: true }), 'other')).toBe(
      'Ctrl+Shift+Q',
    );
    expect(chordOf(ev('¡', 'Digit1', { altKey: true }), 'other')).toBe('Alt+1');
    expect(chordOf(ev('Tab', 'Tab', { ctrlKey: true }), 'other')).toBe('Ctrl+Tab');
    expect(chordOf(ev('ArrowLeft', 'ArrowLeft', { altKey: true }), 'other')).toBe('Alt+Left');
    expect(chordOf(ev('}', 'BracketRight', { metaKey: true, shiftKey: true }), 'mac')).toBe(
      'Ctrl+Shift+]',
    );
  });

  it('treats Cmd as the primary modifier and keeps Control apart on macOS', () => {
    expect(chordOf(ev('w', 'KeyW', { metaKey: true }), 'mac')).toBe('Ctrl+W');
    expect(chordOf(ev('q', 'KeyQ', { ctrlKey: true }), 'mac')).toBe('Control+Q');
    // Elsewhere the Windows/Super key counts as Ctrl, as before.
    expect(chordOf(ev('w', 'KeyW', { metaKey: true }), 'other')).toBe('Ctrl+W');
  });

  it('labels chords with macOS symbols in the usual order', () => {
    expect(chordLabel('Ctrl+Alt+L', 'mac')).toBe('⌥⌘L');
    expect(chordLabel('Control+Shift+Tab', 'mac')).toBe('⌃⇧Tab');
    expect(chordLabel('Ctrl+Alt+L', 'other')).toBe('Ctrl+Alt+L');
    expect(shortcutLabel('settings.open', defaultKeymap('mac'), 'mac')).toBe('⌥⌘S');
  });
});

describe('action resolution', () => {
  const keymap = defaultKeymap('other');

  it('picks the focused context over global, then falls back to global', () => {
    const custom = { ...keymap, 'grid.copy': ['Ctrl+Shift+Q'] };
    expect(resolveAction('Ctrl+Shift+Q', 'grid', custom)).toBe('grid.copy');
    expect(resolveAction('Ctrl+Shift+Q', 'explorer', custom)).toBe('console.new');
    expect(resolveAction('Ctrl+Shift+Q', 'global', custom)).toBe('console.new');
    // Context actions never fire outside their context.
    expect(resolveAction('Ctrl+C', 'editor', keymap)).toBeNull();
    expect(resolveAction('Ctrl+C', 'grid', keymap)).toBe('grid.copy');
    expect(resolveAction('Ctrl+K', 'global', keymap)).toBeNull();
  });

  it('finds the context from the focused element', () => {
    document.body.innerHTML =
      '<div data-action-context="grid"><button id="in">x</button></div><button id="out">y</button>';
    expect(contextOf(document.getElementById('in'))).toBe('grid');
    expect(contextOf(document.getElementById('out'))).toBe('global');
    expect(contextOf(null)).toBe('global');
  });

  it('applies overrides per action and ignores unknown ids', () => {
    const next = effectiveKeymap(
      { 'query.run': ['Ctrl+R'], 'tab.close': [], 'gone.action': ['F1'] },
      'other',
    );
    expect(next['query.run']).toEqual(['Ctrl+R']);
    expect(next['tab.close']).toEqual([]);
    expect(next['console.new']).toEqual(['Ctrl+Shift+Q']);
    expect(resolveAction('Ctrl+Enter', 'global', next)).toBeNull();
    expect(resolveAction('Ctrl+R', 'global', next)).toBe('query.run');
  });
});

describe('conflicts', () => {
  it('has no conflicts in the defaults on any platform', () => {
    for (const platform of ['mac', 'other'] as const) {
      const keymap = defaultKeymap(platform);
      expect(conflicts(keymap).size, platform).toBe(0);
      for (const action of ACTIONS) {
        for (const chord of keymap[action.id]) {
          expect(unbindableReason(chord, action.context, platform), `${platform} ${chord}`).toBe(
            null,
          );
        }
      }
    }
  });

  it('reports same-context clashes and global shadowing', () => {
    const keymap = {
      ...defaultKeymap('other'),
      'query.cancel': ['Ctrl+Enter'],
      'grid.copy': ['Ctrl+W'],
    };
    const found = conflicts(keymap);
    expect(found.get('query.cancel')).toEqual([
      { chord: 'Ctrl+Enter', other: 'query.run', kind: 'same' },
    ]);
    expect(found.get('query.run')).toEqual([
      { chord: 'Ctrl+Enter', other: 'query.cancel', kind: 'same' },
    ]);
    expect(found.get('grid.copy')).toEqual([
      { chord: 'Ctrl+W', other: 'tab.close', kind: 'shadow' },
    ]);
    // Different panels never collide: Delete is bound in both the grid and the explorer.
    expect(found.get('grid.deleteRows')).toBeUndefined();
  });

  it('blocks reserved chords and plain typing keys for global actions', () => {
    expect(unbindableReason('Ctrl+Q', 'global', 'mac')).toMatch(/quits the app/);
    expect(unbindableReason('Alt+F4', 'grid', 'other')).toMatch(/closes the window/);
    expect(unbindableReason('Q', 'global', 'other')).toMatch(/Add Ctrl or Alt/);
    expect(unbindableReason('Shift+Q', 'global', 'other')).toMatch(/Add Ctrl or Alt/);
    expect(unbindableReason('Enter', 'editor', 'other')).toMatch(/typing in the editor/);
    expect(unbindableReason('Tab', 'global', 'other')).toMatch(/Add Ctrl or Alt/);
    expect(unbindableReason('F5', 'global', 'other')).toBeNull();
    expect(unbindableReason('Shift+F8', 'editor', 'other')).toBeNull();
    expect(unbindableReason('Delete', 'grid', 'other')).toBeNull();
  });
});
