import { beforeEach, describe, expect, it } from 'vitest';
import { nextConsoleTitle, snapshot, useWorkspace } from './workspaceStore';

const initial = useWorkspace.getState();

describe('workspace store', () => {
  beforeEach(() => useWorkspace.setState(initial, true));

  it('names consoles with the lowest free suffix', () => {
    expect(nextConsoleTitle([])).toBe('console');
    expect(nextConsoleTitle(['console'])).toBe('console_1');
    expect(nextConsoleTitle(['console', 'console_2'])).toBe('console_1');
  });

  it('activates the right neighbour when closing the active tab', () => {
    const s = useWorkspace.getState();
    const a = s.newConsole();
    const b = s.newConsole();
    const c = s.newConsole();
    s.activate(b);
    s.closeTab(b);
    expect(useWorkspace.getState().activeTabId).toBe(c);
    s.closeTab(c);
    expect(useWorkspace.getState().activeTabId).toBe(a);
    s.closeTab(a);
    expect(useWorkspace.getState().activeTabId).toBeNull();
  });

  it('clears the caret when the active console changes', () => {
    const s = useWorkspace.getState();
    const a = s.newConsole();
    s.setCaret({ line: 2, column: 12 });
    s.newConsole();
    expect(useWorkspace.getState().caret).toBeNull();
    s.setCaret({ line: 1, column: 1 });
    s.activate(a);
    expect(useWorkspace.getState().caret).toBeNull();
  });

  it('cycles tabs in both directions with wrap-around', () => {
    const s = useWorkspace.getState();
    const a = s.newConsole();
    const b = s.newConsole();
    s.cycleTab(1);
    expect(useWorkspace.getState().activeTabId).toBe(a);
    s.cycleTab(-1);
    expect(useWorkspace.getState().activeTabId).toBe(b);
  });

  it('round-trips through snapshot/hydrate and repairs a dangling active tab', () => {
    const s = useWorkspace.getState();
    const a = s.newConsole();
    s.updateText(a, 'select 1;');
    s.setLayout('main', { explorer: 30, center: 70 });
    s.setBottomCollapsed(true);
    const saved = { ...snapshot(useWorkspace.getState()), activeTabId: 'gone' };

    useWorkspace.setState(initial, true);
    useWorkspace.getState().hydrate(saved);
    const restored = useWorkspace.getState();
    expect(restored.tabs).toEqual([{ id: a, title: 'console', text: 'select 1;' }]);
    expect(restored.activeTabId).toBe(a);
    expect(restored.layout.main).toEqual({ explorer: 30, center: 70 });
    expect(restored.bottomCollapsed).toBe(true);
  });
});
