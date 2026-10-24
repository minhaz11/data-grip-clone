import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backend } from '../ipc/client';
import {
  AUTOSAVE_MS,
  isConsole,
  nextConsoleTitle,
  resetHydrationForTests,
  snapshot,
  useWorkspace,
} from './workspaceStore';

const initial = useWorkspace.getState();
const ws = () => useWorkspace.getState();
const consoles = () => ws().tabs.filter(isConsole);

describe('workspace store', () => {
  beforeEach(() => {
    useWorkspace.setState(initial, true);
    resetHydrationForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('names consoles with the lowest free suffix', () => {
    expect(nextConsoleTitle([])).toBe('console');
    expect(nextConsoleTitle(['console'])).toBe('console_1');
    expect(nextConsoleTitle(['console', 'console_2'])).toBe('console_1');
  });

  it('creates console files bound to a data source and activates neighbours on close', async () => {
    const a = await ws().newConsole('src-1');
    const b = await ws().newConsole();
    const c = await ws().newConsole();
    expect(ws().tabs.find((t) => t.id === a)).toMatchObject({
      sourceId: 'src-1',
      text: '',
      save: 'saved',
    });
    ws().activate(b);
    await ws().closeTab(b);
    expect(ws().activeTabId).toBe(c);
    await ws().closeTab(c);
    expect(ws().activeTabId).toBe(a);
  });

  it('autosaves text to the console file after a short pause', async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(backend, 'consoleWrite');
    const id = await ws().newConsole();
    const name = consoles()[0]?.console ?? '';

    ws().updateText(id, 'select 1');
    ws().updateText(id, 'select 12');
    expect(consoles()[0]?.save).toBe('pending');
    expect(write).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(name, 'select 12');
    expect(consoles()[0]?.save).toBe('saved');
    expect(await backend.consoleRead(name)).toBe('select 12');
  });

  it('flushes unsaved text when a tab closes and reports write failures', async () => {
    const id = await ws().newConsole();
    const name = consoles()[0]?.console ?? '';
    ws().updateText(id, 'select 2');
    await ws().closeTab(id);
    expect(await backend.consoleRead(name)).toBe('select 2');

    const other = await ws().newConsole();
    vi.spyOn(backend, 'consoleWrite').mockRejectedValueOnce({
      kind: 'storage',
      message: 'disk full',
    });
    ws().updateText(other, 'x');
    await ws().flushAll();
    expect(ws().tabs[0]).toMatchObject({ save: 'error', saveError: 'disk full' });
  });

  it('never persists console text in the workspace snapshot', async () => {
    const id = await ws().newConsole('src');
    ws().updateText(id, 'secret-ish query text');
    const snap = snapshot(ws());
    expect(snap.tabs).toEqual([{ id, console: consoles()[0]?.console, sourceId: 'src' }]);
    expect(JSON.stringify(snap)).not.toContain('secret-ish');
  });

  it('migrates legacy inline text into console files exactly once', async () => {
    const create = vi.spyOn(backend, 'consoleCreate');
    const legacy = {
      layout: {},
      panels: { explorerCollapsed: false, bottomCollapsed: true },
      tabs: [{ id: 'old-1', title: 'legacy_tab', text: 'select 42;' }],
      activeTabId: 'old-1',
    };
    // React StrictMode may request hydration twice; the migration must not duplicate files.
    await Promise.all([ws().hydrate(legacy), ws().hydrate(legacy)]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(ws().tabs).toEqual([
      { id: 'old-1', console: 'legacy_tab', sourceId: null, text: 'select 42;', save: 'saved' },
    ]);
    expect(await backend.consoleRead('legacy_tab')).toBe('select 42;');
    expect(ws().bottomCollapsed).toBe(true);
  });

  it('restores file-backed tabs and reports missing console files', async () => {
    const name = await backend.consoleCreate('kept');
    await backend.consoleWrite(name, 'select 7');
    await ws().hydrate({
      layout: {},
      panels: { explorerCollapsed: false, bottomCollapsed: false },
      tabs: [
        { id: 't1', console: 'kept', sourceId: 'src' },
        { id: 't2', console: 'deleted_elsewhere', sourceId: null },
      ],
      activeTabId: 't2',
    });
    expect(consoles().map((t) => [t.id, t.text])).toEqual([['t1', 'select 7']]);
    expect(ws().activeTabId).toBe('t1');
    expect(ws().notices[0]).toContain('deleted_elsewhere');
  });

  it('opens each object once and restores object tabs', async () => {
    const orders = { schema: 'shop', name: 'orders', objectType: 'table' as const };
    const first = ws().openObject('src', orders);
    await ws().newConsole('src');
    expect(ws().openObject('src', orders)).toBe(first);
    expect(ws().activeTabId).toBe(first);
    expect(ws().tabs).toHaveLength(2);
    const other = ws().openObject('src', { ...orders, name: 'customers' });
    expect(other).not.toBe(first);

    const snap = snapshot(ws());
    expect(snap.tabs[0]).toEqual({ id: first, kind: 'object', sourceId: 'src', object: orders });
    useWorkspace.setState(initial, true);
    resetHydrationForTests();
    await ws().hydrate(snap);
    expect(
      ws()
        .tabs.filter((t) => !isConsole(t))
        .map((t) => t.id),
    ).toEqual([first, other]);
    // Text-only operations leave object tabs alone.
    ws().updateText(first, 'select 1');
    await ws().flushAll();
    expect(ws().tabs.find((t) => t.id === first)).toEqual({
      id: first,
      kind: 'object',
      sourceId: 'src',
      object: orders,
    });
  });
});
