import { useCallback, useMemo } from 'react';
import type { ActionContext, ActionId } from '../lib/actions';
import {
  chordOf,
  effectiveKeymap,
  isModifierOnly,
  resolveAction,
  shortcutLabel,
  type Keymap,
} from '../lib/keymap';
import { useSettings } from './settingsStore';

type Overrides = Record<string, string[] | undefined>;

let cached: { overrides: Overrides | undefined; keymap: Keymap } | null = null;

/** The keymap in effect now: defaults plus the saved overrides (for event handlers). */
export function currentKeymap(): Keymap {
  const overrides = useSettings.getState().settings.keymap as Overrides | undefined;
  if (!cached || cached.overrides !== overrides) {
    cached = { overrides, keymap: effectiveKeymap(overrides) };
  }
  return cached.keymap;
}

/** The keymap in effect, re-rendering when the user changes it. */
export function useKeymap(): Keymap {
  const overrides = useSettings((s) => s.settings.keymap) as Overrides | undefined;
  return useMemo(() => effectiveKeymap(overrides), [overrides]);
}

/** The first shortcut of an action as the user reads it, or an empty string. */
export function useShortcut(id: ActionId): string {
  return shortcutLabel(id, useKeymap());
}

/** True while a key press is being recorded as a new shortcut (Settings > Keymap). */
export function isCapturingShortcut(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-keymap-capture]') !== null;
}

/** The action a key press resolves to in `context` (for handlers on single controls). */
export function actionFor(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'target'>,
  context: ActionContext,
): ActionId | null {
  if (isModifierOnly(e) || isCapturingShortcut(e.target)) {
    return null;
  }
  return resolveAction(chordOf(e), context, currentKeymap());
}

/**
 * Key handler for a focusable panel of one context (grid, explorer): runs the registered action
 * the key resolves to and reports whether it did, so the caller can fall back to navigation keys.
 * Global actions never reach it; the window listener handles them first.
 */
export function useContextActions(
  context: ActionContext,
  handlers: Partial<Record<ActionId, ((e: React.KeyboardEvent) => void) | undefined>>,
): (e: React.KeyboardEvent) => boolean {
  return useCallback(
    (e: React.KeyboardEvent) => {
      const id = actionFor(e, context);
      const handler = id ? handlers[id] : undefined;
      if (!handler) {
        return false;
      }
      e.preventDefault();
      e.stopPropagation();
      handler(e);
      return true;
    },
    [context, handlers],
  );
}
