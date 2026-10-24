import { ACTIONS, actionDef, isActionId, type ActionContext, type ActionId } from './actions';

export type Platform = 'mac' | 'other';

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') {
    return 'other';
  }
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'mac' : 'other';
}

export const PLATFORM: Platform = detectPlatform();

/** Bindings of every action, as chords like "Ctrl+Alt+L". */
export type Keymap = Record<ActionId, string[]>;

/** The most bindings one action may have. */
export const MAX_BINDINGS = 4;

export function defaultKeymap(platform: Platform = PLATFORM): Keymap {
  const keymap = {} as Keymap;
  for (const action of ACTIONS) {
    const mac = 'mac' in action ? action.mac : undefined;
    keymap[action.id] = [...(platform === 'mac' && mac ? mac : action.defaults)];
  }
  return keymap;
}

export const DEFAULT_KEYMAP: Keymap = defaultKeymap();

/** Defaults with the user's overrides applied; an override replaces all of an action's bindings. */
export function effectiveKeymap(
  overrides: Record<string, string[] | undefined> | undefined,
  platform: Platform = PLATFORM,
): Keymap {
  const keymap = defaultKeymap(platform);
  for (const [id, chords] of Object.entries(overrides ?? {})) {
    if (isActionId(id) && chords) {
      keymap[id] = chords.slice(0, MAX_BINDINGS);
    }
  }
  return keymap;
}

const KEY_ALIASES: Record<string, string> = {
  ' ': 'Space',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
};

/** Punctuation by physical key, so Shift and keyboard layouts do not change the chord. */
const CODE_KEYS: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
};

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift', 'AltGraph', 'OS']);

type KeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
>;

/** A key press of only Ctrl, Alt, Shift or Cmd (not a chord yet). */
export function isModifierOnly(e: Pick<KeyboardEvent, 'key'>): boolean {
  return MODIFIER_KEYS.has(e.key);
}

/**
 * Normalizes a keyboard event to "Ctrl+Control+Alt+Shift+Key". "Ctrl" is the primary modifier:
 * Ctrl (or Cmd) on Windows and Linux, Cmd on macOS, where the physical Control key is "Control".
 */
export function chordOf(e: KeyEventLike, platform: Platform = PLATFORM): string {
  // Use the physical key for letters and digits so Shift/Alt layouts still match ("Alt+1").
  let key = e.key;
  if (/^Key[A-Z]$/.test(e.code)) {
    key = e.code.slice(3);
  } else if (/^Digit[0-9]$/.test(e.code)) {
    key = e.code.slice(5);
  } else if (CODE_KEYS[e.code]) {
    key = CODE_KEYS[e.code] ?? key;
  }
  key = KEY_ALIASES[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  const parts: string[] = [];
  if (platform === 'mac') {
    if (e.metaKey) {
      parts.push('Ctrl');
    }
    if (e.ctrlKey) {
      parts.push('Control');
    }
  } else if (e.ctrlKey || e.metaKey) {
    parts.push('Ctrl');
  }
  if (e.altKey) {
    parts.push('Alt');
  }
  if (e.shiftKey) {
    parts.push('Shift');
  }
  parts.push(key);
  return parts.join('+');
}

/** The context of the focused element: the nearest `data-action-context` ancestor. */
export function contextOf(target: EventTarget | null): ActionContext {
  const el =
    target instanceof Element ? target.closest<HTMLElement>('[data-action-context]') : null;
  const context = el?.dataset.actionContext;
  return context === 'editor' || context === 'grid' || context === 'explorer' ? context : 'global';
}

/** The action `chord` triggers in `context`: an action of that context first, then a global one. */
export function resolveAction(
  chord: string,
  context: ActionContext,
  keymap: Keymap = DEFAULT_KEYMAP,
): ActionId | null {
  let global: ActionId | null = null;
  for (const action of ACTIONS) {
    if (!keymap[action.id].includes(chord)) {
      continue;
    }
    if (action.context === context && context !== 'global') {
      return action.id;
    }
    if (action.context === 'global' && !global) {
      global = action.id;
    }
  }
  return global;
}

const MAC_SYMBOLS: Record<string, string> = {
  Ctrl: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
};
const MAC_ORDER = ['Control', 'Alt', 'Shift', 'Ctrl'];

/** How a chord reads to the user: "Ctrl+Alt+L", or "⌥⌘L" on macOS. */
export function chordLabel(chord: string, platform: Platform = PLATFORM): string {
  if (platform !== 'mac') {
    return chord;
  }
  const parts = chord.split('+');
  // "Ctrl++" is not produced (Equal and Plus map to "="), so the last part is always the key.
  const key = parts.pop() ?? '';
  const mods = MAC_ORDER.filter((m) => parts.includes(m)).map((m) => MAC_SYMBOLS[m] ?? m);
  return `${mods.join('')}${key}`;
}

/** First binding of an action, for tooltips ("New console (Ctrl+Shift+Q)"); empty if unbound. */
export function shortcutLabel(
  id: ActionId,
  keymap: Keymap = DEFAULT_KEYMAP,
  platform: Platform = PLATFORM,
): string {
  const chord = keymap[id][0];
  return chord ? chordLabel(chord, platform) : '';
}

export interface Conflict {
  chord: string;
  other: ActionId;
  /** `same`: both apply in one context, so one can never run. `shadow`: a context action hides a
   * global one while that context has focus. */
  kind: 'same' | 'shadow';
}

/** Every chord bound to more than one action that can collide, per action. */
export function conflicts(keymap: Keymap): Map<ActionId, Conflict[]> {
  const byChord = new Map<string, ActionId[]>();
  for (const action of ACTIONS) {
    for (const chord of keymap[action.id]) {
      byChord.set(chord, [...(byChord.get(chord) ?? []), action.id]);
    }
  }
  const found = new Map<ActionId, Conflict[]>();
  const add = (id: ActionId, conflict: Conflict) =>
    found.set(id, [...(found.get(id) ?? []), conflict]);
  for (const [chord, ids] of byChord) {
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) {
          continue;
        }
        const ca = actionDef(a).context;
        const cb = actionDef(b).context;
        if (ca === cb) {
          add(a, { chord, other: b, kind: 'same' });
        } else if (ca === 'global' || cb === 'global') {
          add(a, { chord, other: b, kind: 'shadow' });
        }
      }
    }
  }
  return found;
}

/** Chords the operating system or window manager handles before the app sees them. */
const RESERVED: Record<Platform, Record<string, string>> = {
  mac: {
    'Ctrl+Q': 'quits the app',
    'Ctrl+H': 'hides the app',
    'Ctrl+Alt+H': 'hides other apps',
    'Ctrl+M': 'minimizes the window',
    'Ctrl+Tab': 'switches apps',
    'Ctrl+Space': 'opens Spotlight',
    'Ctrl+Shift+3': 'takes a screenshot',
    'Ctrl+Shift+4': 'takes a screenshot',
    'Ctrl+Shift+5': 'takes a screenshot',
  },
  other: {
    'Alt+F4': 'closes the window',
    'Alt+Tab': 'switches windows',
    'Ctrl+Alt+Delete': 'is handled by the system',
  },
};

/**
 * Why `chord` cannot be bound in `context`, or `null` if it can. A `declinable` action passes
 * keys it does not use on, so plain keys are allowed for it.
 */
export function unbindableReason(
  chord: string,
  context: ActionContext,
  platform: Platform = PLATFORM,
  declinable = false,
): string | null {
  const reserved = RESERVED[platform][chord];
  if (reserved) {
    return `${chordLabel(chord, platform)} ${reserved}.`;
  }
  const parts = chord.split('+');
  const key = parts[parts.length - 1] ?? '';
  const modified = parts.some((p) => p === 'Ctrl' || p === 'Control' || p === 'Alt');
  // Without Ctrl or Alt only function keys are safe where text is typed: anything else (letters,
  // Enter, Tab, Delete, arrows) would stop editing. Grid and explorer keys are not typed text.
  const typed = context === 'global' || context === 'editor';
  if (typed && !declinable && !modified && !/^F\d{1,2}$/.test(key)) {
    return context === 'global'
      ? 'Add Ctrl or Alt: a plain key would stop typing everywhere.'
      : 'Add Ctrl or Alt: a plain key would stop typing in the editor.';
  }
  return null;
}
