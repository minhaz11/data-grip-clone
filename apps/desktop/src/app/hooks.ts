import { useEffect, useState } from 'react';
import { backend } from '../ipc/client';
import type { ActionId } from '../lib/actions';
import { chordOf, contextOf, isModifierOnly, resolveAction } from '../lib/keymap';
import { currentKeymap, isCapturingShortcut } from './keymapStore';
import { resolveTheme, useSettings } from './settingsStore';
import { snapshot, useWorkspace } from './workspaceStore';
import { useConnections } from '../features/connections/connectionsStore';
import { useSnippets } from '../features/snippets/snippetsStore';
import { useSessions } from '../features/connections/sessionsStore';
import { resetCatalog } from '../features/editor/catalog';
import { askQuit } from '../features/exec/txGuards';
import { useTx } from '../features/exec/txStore';

/**
 * App-level shortcuts, dispatched through the action registry and the user's keymap. The focused
 * panel's context decides: its own actions win, and grid and explorer actions are left to those
 * panels' handlers. Runs in the capture phase, so Monaco never sees a chord bound to an action.
 */
/** An action handler; returning `false` declines the key, which then goes to the focused control. */
export type ActionHandler = () => unknown;

export function useKeybindings(handlers: Partial<Record<ActionId, ActionHandler>>) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isModifierOnly(e) || isCapturingShortcut(e.target)) {
        return;
      }
      // A modal dialog owns the keyboard: app shortcuts wait until it is closed.
      if (e.target instanceof Element && e.target.closest('[aria-modal="true"]')) {
        return;
      }
      const id = resolveAction(chordOf(e), contextOf(e.target), currentKeymap());
      const handler = id ? handlers[id] : undefined;
      if (handler && handler() !== false) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [handlers]);
}

/** Applies the effective theme to <html data-theme> and follows the OS when set to "system". */
export function useAppliedTheme(): 'light' | 'dark' {
  const pref = useSettings((s) => s.settings.theme);
  const [prefersDark, setPrefersDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const listener = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, []);
  const theme = resolveTheme(pref, prefersDark);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return theme;
}

const SAVE_DEBOUNCE_MS = 300;

/** Loads settings + workspace once, then saves workspace changes (debounced) to the backend. */
export function useWorkspacePersistence(): { ready: boolean; error: string | null } {
  const [state, setState] = useState<{ ready: boolean; error: string | null }>({
    ready: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;

    (async () => {
      try {
        await useSettings.getState().load();
        await useConnections.getState().load();
        await useSnippets.getState().load();
        unlistenStatus = await useSessions.getState().init();
        const unlistenTx = await useTx.getState().init();
        const unlistenQuit = await backend.onQuitRequested((open) => void askQuit(open));
        // Completion catalogs are only valid for the session they were read from.
        const unsubscribeCatalog = useSessions.subscribe((s, prev) => {
          for (const id of Object.keys(prev.byId)) {
            if (prev.byId[id]?.state === 'connected' && s.byId[id]?.state !== 'connected')
              resetCatalog(id);
          }
        });
        const unlisten = unlistenStatus;
        unlistenStatus = () => {
          unlisten();
          unlistenTx();
          unlistenQuit();
          unsubscribeCatalog();
        };
        await useWorkspace.getState().hydrate(await backend.workspaceGet());
      } catch (e) {
        await useWorkspace.getState().hydrate(null);
        if (!cancelled)
          setState((s) => ({ ...s, error: `Could not restore workspace: ${String(e)}` }));
      }
      if (cancelled) return;
      setState((s) => ({ ...s, ready: true }));
      let lastSaved = JSON.stringify(snapshot(useWorkspace.getState()));
      unsubscribe = useWorkspace.subscribe((ws) => {
        // Text edits and caret moves change the store but not the persisted snapshot.
        const next = JSON.stringify(snapshot(ws));
        if (next === lastSaved) return;
        lastSaved = next;
        clearTimeout(timer);
        timer = setTimeout(() => {
          backend
            .workspaceSet(snapshot(useWorkspace.getState()))
            .catch((e: unknown) =>
              setState((s) => ({ ...s, error: `Could not save workspace: ${String(e)}` })),
            );
        }, SAVE_DEBOUNCE_MS);
      });
    })();

    // Unsaved console text is written when the window is hidden or closed.
    const flush = () => void useWorkspace.getState().flushAll();
    const onVisibility = () => document.visibilityState === 'hidden' && flush();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
      cancelled = true;
      clearTimeout(timer);
      unsubscribe?.();
      unlistenStatus?.();
    };
  }, []);

  return state;
}
