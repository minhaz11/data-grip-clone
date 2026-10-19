import { useEffect, useState } from 'react';
import { backend } from '../ipc/client';
import { chordOf, commandForChord, type CommandId } from '../lib/keymap';
import { resolveTheme, useSettings } from './settingsStore';
import { snapshot, useWorkspace } from './workspaceStore';

/** Global keyboard shortcuts, dispatched through the keymap so bindings stay configurable. */
export function useKeybindings(handlers: Partial<Record<CommandId, () => void>>) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const command = commandForChord(chordOf(e));
      const handler = command ? handlers[command] : undefined;
      if (handler) {
        e.preventDefault();
        e.stopPropagation();
        handler();
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

    (async () => {
      try {
        await useSettings.getState().load();
        useWorkspace.getState().hydrate(await backend.workspaceGet());
      } catch (e) {
        useWorkspace.getState().hydrate(null);
        if (!cancelled)
          setState((s) => ({ ...s, error: `Could not restore workspace: ${String(e)}` }));
      }
      if (cancelled) return;
      setState((s) => ({ ...s, ready: true }));
      unsubscribe = useWorkspace.subscribe((ws, prev) => {
        if (ws.caret !== prev.caret && ws.tabs === prev.tabs && ws.layout === prev.layout) return;
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

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, []);

  return state;
}
