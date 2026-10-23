export type CommandId =
  | 'console.new'
  | 'tab.close'
  | 'tab.next'
  | 'tab.previous'
  | 'view.toggleExplorer'
  | 'view.toggleBottomPanel'
  | 'settings.open'
  | 'datasource.new'
  | 'editor.format'
  | 'editor.nextError'
  | 'editor.previousError'
  | 'query.run'
  | 'query.runScript'
  | 'query.cancel'
  | 'history.open';

/** Default bindings. Phase 5 makes these user-configurable; keep ids stable. */
export const DEFAULT_KEYMAP: Record<CommandId, string[]> = {
  'console.new': ['Ctrl+Shift+Q'],
  'tab.close': ['Ctrl+W', 'Ctrl+F4'],
  'tab.next': ['Ctrl+Tab', 'Alt+Right'],
  'tab.previous': ['Ctrl+Shift+Tab', 'Alt+Left'],
  'view.toggleExplorer': ['Alt+1'],
  'view.toggleBottomPanel': ['Alt+4'],
  'settings.open': ['Ctrl+Alt+S'],
  'datasource.new': ['Alt+Insert'],
  'editor.format': ['Ctrl+Alt+L'],
  'editor.nextError': ['F8'],
  'editor.previousError': ['Shift+F8'],
  'query.run': ['Ctrl+Enter'],
  'query.runScript': ['Ctrl+Shift+F10'],
  'query.cancel': ['Ctrl+F2'],
  'history.open': ['Ctrl+Alt+E'],
};

const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
};

/** Normalizes a keyboard event to "Ctrl+Alt+Shift+Key" (Meta maps to Ctrl so macOS Cmd works). */
export function chordOf(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
): string {
  // Use the physical key for letters/digits so Shift/Alt layouts still match ("Alt+1", "Ctrl+Shift+Q").
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  key = KEY_ALIASES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

export function commandForChord(chord: string, keymap = DEFAULT_KEYMAP): CommandId | null {
  for (const [id, chords] of Object.entries(keymap) as [CommandId, string[]][]) {
    if (chords.includes(chord)) return id;
  }
  return null;
}

/** First binding of a command, for tooltips ("New console (Ctrl+Shift+Q)"). */
export function shortcutLabel(id: CommandId, keymap = DEFAULT_KEYMAP): string {
  return keymap[id][0] ?? '';
}
