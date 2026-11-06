import { create } from 'zustand';
import { activeEditor } from '../features/editor/editorHandle';
import { isConsole, useWorkspace } from './workspaceStore';

/** A place to go back to: a tab and, for consoles, the caret in it. */
export interface NavLocation {
  tabId: string;
  caret: { line: number; column: number } | null;
}

/** Back and forward stacks are capped; the oldest entries go first. */
export const MAX_NAV = 50;

interface NavState {
  back: NavLocation[];
  forward: NavLocation[];
  /** Tab ids, most recently active first. */
  recent: string[];
}

export const useNav = create<NavState>(() => ({ back: [], forward: [], recent: [] }));

// Set while back/forward switch tabs, so the switch is not recorded as a new step.
let navigating = false;

useWorkspace.subscribe((s, prev) => {
  const open = new Set(s.tabs.map((t) => t.id));
  const alive = (l: NavLocation) => open.has(l.tabId);
  if (s.activeTabId !== prev.activeTabId) {
    useNav.setState((n) => {
      const recent = s.activeTabId
        ? [s.activeTabId, ...n.recent.filter((id) => id !== s.activeTabId)]
        : n.recent;
      if (navigating || !prev.activeTabId) {
        return { recent: recent.filter((id) => open.has(id)) };
      }
      const from: NavLocation = { tabId: prev.activeTabId, caret: prev.caret };
      return {
        back: [...n.back, from].filter(alive).slice(-MAX_NAV),
        forward: [],
        recent: recent.filter((id) => open.has(id)),
      };
    });
  } else if (s.tabs !== prev.tabs) {
    useNav.setState((n) => ({
      back: n.back.filter(alive),
      forward: n.forward.filter(alive),
      recent: n.recent.filter((id) => open.has(id)),
    }));
  }
});

/** Offset of a 1-based line and column in `text`. */
export function offsetOf(text: string, caret: { line: number; column: number }): number {
  let offset = 0;
  for (let line = 1; line < caret.line; line++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) {
      return text.length;
    }
    offset = next + 1;
  }
  return Math.min(text.length, offset + caret.column - 1);
}

function go(to: NavLocation) {
  const ws = useWorkspace.getState();
  navigating = true;
  try {
    ws.activate(to.tabId);
  } finally {
    navigating = false;
  }
  const tab = useWorkspace.getState().tabs.find((t) => t.id === to.tabId);
  if (to.caret && isConsole(tab)) {
    const caret = to.caret;
    // The editor switches models on the next render.
    setTimeout(() => activeEditor()?.revealOffset(offsetOf(tab.text, caret)), 0);
  }
}

function here(): NavLocation | null {
  const ws = useWorkspace.getState();
  return ws.activeTabId ? { tabId: ws.activeTabId, caret: ws.caret } : null;
}

export function goBack(): boolean {
  const { back, forward } = useNav.getState();
  const to = back[back.length - 1];
  const from = here();
  if (!to) {
    return false;
  }
  useNav.setState({
    back: back.slice(0, -1),
    forward: from ? [...forward, from].slice(-MAX_NAV) : forward,
  });
  go(to);
  return true;
}

export function goForward(): boolean {
  const { back, forward } = useNav.getState();
  const to = forward[forward.length - 1];
  const from = here();
  if (!to) {
    return false;
  }
  useNav.setState({
    forward: forward.slice(0, -1),
    back: from ? [...back, from].slice(-MAX_NAV) : back,
  });
  go(to);
  return true;
}

/**
 * Records the current caret as a step before a jump inside the same tab (Go to DDL, go to
 * error), so Back returns to it.
 */
export function recordJump() {
  const from = here();
  if (from) {
    useNav.setState((n) => ({ back: [...n.back, from].slice(-MAX_NAV), forward: [] }));
  }
}
