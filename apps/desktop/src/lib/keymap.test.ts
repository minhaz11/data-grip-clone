import { describe, expect, it } from 'vitest';
import { chordOf, commandForChord, DEFAULT_KEYMAP } from './keymap';

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

describe('keymap', () => {
  it('normalizes chords using physical keys', () => {
    expect(chordOf(ev('Q', 'KeyQ', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Q');
    expect(chordOf(ev('¡', 'Digit1', { altKey: true }))).toBe('Alt+1');
    expect(chordOf(ev('Tab', 'Tab', { ctrlKey: true }))).toBe('Ctrl+Tab');
    expect(chordOf(ev('ArrowLeft', 'ArrowLeft', { altKey: true }))).toBe('Alt+Left');
  });

  it('maps macOS Cmd to Ctrl', () => {
    expect(chordOf(ev('w', 'KeyW', { metaKey: true }))).toBe('Ctrl+W');
  });

  it('resolves commands and has no duplicate bindings', () => {
    expect(commandForChord('Ctrl+Shift+Q')).toBe('console.new');
    expect(commandForChord('Ctrl+Alt+S')).toBe('settings.open');
    expect(commandForChord('Ctrl+K')).toBeNull();
    const all = Object.values(DEFAULT_KEYMAP).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});
