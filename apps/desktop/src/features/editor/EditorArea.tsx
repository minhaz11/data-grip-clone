import clsx from 'clsx';
import { AlignLeft, ChevronDown, ListChecks, Pin, Play, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ContextMenu, type MenuItem } from '../../components/ui/ContextMenu';
import { backend } from '../../ipc/client';
import { revealInTree } from '../navigation/objects';
import { deleteConsole, duplicateConsole, renameConsole } from './ConsoleDialogs';
import { useSettings } from '../../app/settingsStore';
import { isConsole, useWorkspace, type ConsoleTab, type EditorTab } from '../../app/workspaceStore';
import { DataTab } from '../data/DataTab';
import { DdlViewer } from '../schema/DdlViewer';
import { ObjectViewer } from '../schema/ObjectViewer';
import { useKeymap } from '../../app/keymapStore';
import { shortcutLabel } from '../../lib/keymap';
import { useConnections } from '../connections/connectionsStore';
import { effectiveColor } from '../connections/model';
import { activeEditor } from './editorHandle';
import { SqlEditor } from './SqlEditor';
import { isRunning, useExec } from '../exec/execStore';
import { runFromEditor } from '../exec/runQuery';
import { TxControls } from '../exec/TxControls';
import { changeSource, closeConsole } from '../exec/txGuards';
import { keyOf, sessionOf, useTx } from '../exec/txStore';

let consolesDir: Promise<string> | null = null;

/** Where console files live, read once (for tab tooltips). */
function useConsolesDir(): string | null {
  const [dir, setDir] = useState<string | null>(null);
  useEffect(() => {
    consolesDir ??= backend.consolesDir().catch(() => '');
    let live = true;
    void consolesDir.then((d) => live && setDir(d || null));
    return () => {
      live = false;
    };
  }, []);
  return dir;
}

/** Closes tabs one by one; each console with an open transaction asks first. */
async function closeTabs(ids: string[]) {
  for (const id of ids) {
    await closeConsole(id);
  }
}

export function EditorArea({ theme }: { theme: 'light' | 'dark' }) {
  const keymap = useKeymap();
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const activate = useWorkspace((s) => s.activate);
  const closedCount = useWorkspace((s) => s.closed.length);
  const closeTab = closeConsole;
  const newConsole = useWorkspace((s) => s.newConsole);
  const sources = useConnections((s) => s.items);
  const selectedSourceId = useConnections((s) => s.selectedId);
  const active = tabs.find((t) => t.id === activeTabId);
  const dir = useConsolesDir();
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string | null } | null>(null);
  const tablistRef = useRef<HTMLDivElement>(null);

  const pathOf = (tab: ConsoleTab) =>
    dir ? `${dir}${dir.includes('\\') ? '\\' : '/'}${tab.console}.sql` : `${tab.console}.sql`;

  function focusTab(id: string) {
    activate(id);
    // After the render that makes it the roving tab stop.
    setTimeout(() => document.getElementById(`tab-${id}`)?.focus(), 0);
  }

  function menuItems(tab: EditorTab): MenuItem[] {
    const index = tabs.findIndex((t) => t.id === tab.id);
    const unpinned = (list: EditorTab[]) => list.filter((t) => !t.pinned).map((t) => t.id);
    const items: MenuItem[] = [
      {
        label: 'Close',
        shortcut: shortcutLabel('tab.close', keymap),
        onSelect: () => void closeTab(tab.id),
      },
      {
        label: 'Close others',
        onSelect: () => void closeTabs(unpinned(tabs.filter((t) => t.id !== tab.id))),
      },
      {
        label: 'Close tabs to the right',
        onSelect: () => void closeTabs(unpinned(tabs.slice(index + 1))),
      },
      { label: 'Close all', onSelect: () => void closeTabs(unpinned(tabs)) },
      {
        label: tab.pinned ? 'Unpin tab' : 'Pin tab',
        onSelect: () => useWorkspace.getState().setPinned(tab.id, !tab.pinned),
      },
    ];
    if (closedCount > 0) {
      items.push({
        label: 'Reopen closed tab',
        shortcut: shortcutLabel('tab.reopenClosed', keymap),
        onSelect: () => void useWorkspace.getState().reopenClosed(),
      });
    }
    if (isConsole(tab)) {
      items.push(
        { label: 'Rename console…', onSelect: () => void renameConsole(tab.id) },
        { label: 'Duplicate console', onSelect: () => void duplicateConsole(tab.id) },
        { label: 'Copy path', onSelect: () => void navigator.clipboard?.writeText(pathOf(tab)) },
        { label: 'Delete console…', danger: true, onSelect: () => void deleteConsole(tab.id) },
      );
    } else if (tab.kind === 'object' || tab.kind === 'data') {
      const o = tab.object;
      items.push({
        label: 'Reveal in explorer',
        onSelect: () =>
          revealInTree({
            sourceId: tab.sourceId,
            schema: o.schema,
            name: o.name,
            kind: o.objectType,
          }),
      });
    }
    return items;
  }

  function onTabKeyDown(e: React.KeyboardEvent, tab: EditorTab) {
    const index = tabs.findIndex((t) => t.id === tab.id);
    let next: EditorTab | undefined;
    if (e.key === 'ArrowRight') {
      next = tabs[(index + 1) % tabs.length];
    } else if (e.key === 'ArrowLeft') {
      next = tabs[(index - 1 + tabs.length) % tabs.length];
    } else if (e.key === 'Home') {
      next = tabs[0];
    } else if (e.key === 'End') {
      next = tabs[tabs.length - 1];
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setMenu({ x: rect.left, y: rect.bottom, tabId: tab.id });
      return;
    } else {
      return;
    }
    e.preventDefault();
    if (next) {
      focusTab(next.id);
    }
  }

  if (tabs.length === 0) {
    return (
      <section
        aria-label="Editor"
        className="flex h-full flex-col items-center justify-center gap-3 bg-bg text-muted"
      >
        <p>No open consoles.</p>
        <button
          type="button"
          onClick={() => void newConsole(selectedSourceId)}
          className="rounded border border-border px-3 py-1 text-fg hover:bg-hover"
        >
          New console <span className="text-muted">({shortcutLabel('console.new', keymap)})</span>
        </button>
      </section>
    );
  }

  return (
    <section aria-label="Editor" className="flex h-full flex-col bg-bg">
      <div className="flex h-8 shrink-0 border-b border-border bg-panel">
        <div
          ref={tablistRef}
          role="tablist"
          aria-label="Open editors"
          className="flex min-w-0 flex-1 overflow-x-auto"
        >
          {tabs.map((tab) => {
            const selected = tab.id === activeTabId;
            const source = sources.find((s) => s.id === tab.sourceId);
            const color = source ? effectiveColor(source) : null;
            return (
              <div
                key={tab.id}
                role="presentation"
                className={clsx(
                  'group flex items-center border-r border-border',
                  selected
                    ? 'bg-bg text-fg shadow-[inset_0_-2px_0_var(--q-accent)]'
                    : 'text-muted hover:bg-hover',
                )}
                style={color ? { borderTop: `2px solid ${color}` } : undefined}
                onAuxClick={(e) => e.button === 1 && void closeTab(tab.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id });
                }}
              >
                <button
                  type="button"
                  role="tab"
                  id={`tab-${tab.id}`}
                  aria-selected={selected}
                  aria-controls="editor-tabpanel"
                  tabIndex={selected ? 0 : -1}
                  onClick={() => activate(tab.id)}
                  onKeyDown={(e) => onTabKeyDown(e, tab)}
                  title={[
                    isConsole(tab) ? pathOf(tab) : tabTitle(tab),
                    source && `Data source: ${source.name}`,
                    tab.pinned && 'Pinned',
                    isConsole(tab) && tab.saveError,
                  ]
                    .filter(Boolean)
                    .join('\n')}
                  className="flex h-full items-center pl-3 pr-1 font-mono text-[12px]"
                >
                  {tab.pinned && (
                    <Pin size={11} className="mr-1 shrink-0 text-muted" aria-label="pinned" />
                  )}
                  {tabLabel(tab)}
                  {isConsole(tab) && tab.save === 'error' && (
                    <span className="ml-1 text-danger" aria-label="save failed">
                      !
                    </span>
                  )}
                  {isConsole(tab) && (tab.save === 'pending' || tab.save === 'saving') && (
                    <span className="ml-1" aria-label="unsaved changes">
                      •
                    </span>
                  )}
                  {isConsole(tab) && <TabTxBadge tab={tab} />}
                </button>
                {/* Mouse affordance only: a tablist may contain only tabs, so keyboard and screen-reader
                  users close the active tab with the tab.close shortcut instead. */}
                <button
                  type="button"
                  tabIndex={-1}
                  aria-hidden
                  title={`Close (${shortcutLabel('tab.close', keymap)})`}
                  onClick={() => void closeTab(tab.id)}
                  className="mr-1 rounded p-0.5 opacity-60 hover:bg-hover hover:opacity-100"
                >
                  <X size={12} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          aria-label={`All tabs (${tabs.length})`}
          title="All tabs"
          aria-haspopup="menu"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left - 160, y: rect.bottom, tabId: null });
          }}
          className="flex shrink-0 items-center gap-0.5 border-l border-border px-1.5 text-[11px] text-muted hover:bg-hover hover:text-fg"
        >
          {tabs.length}
          <ChevronDown size={12} aria-hidden />
        </button>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menu.tabId ? 'Tab actions' : 'All tabs'}
          items={
            menu.tabId
              ? (() => {
                  const tab = tabs.find((t) => t.id === menu.tabId);
                  return tab ? menuItems(tab) : [];
                })()
              : tabs.map((t) => ({
                  label: `${t.id === activeTabId ? '• ' : ''}${tabLabel(t)}`,
                  onSelect: () => focusTab(t.id),
                }))
          }
          onClose={() => setMenu(null)}
        />
      )}
      {isConsole(active) && <ConsolePane key={active.id} tab={active} theme={theme} />}
      {active?.kind === 'object' && (
        <ObjectViewer
          key={active.id}
          tabId={active.id}
          sourceId={active.sourceId}
          object={active.object}
        />
      )}
      {active?.kind === 'data' && <DataTab key={active.id} tab={active} />}
      {active?.kind === 'ddl' && (
        <DdlViewer
          key={active.id}
          tabId={active.id}
          sourceId={active.sourceId}
          objects={active.objects}
          title={active.title}
          theme={theme}
        />
      )}
    </section>
  );
}

function tabLabel(tab: EditorTab): string {
  if (isConsole(tab)) {
    return `${tab.console}.sql`;
  }
  if (tab.kind === 'data') {
    return `${tab.object.name} (data)`;
  }
  return tab.kind === 'object' ? tab.object.name : `DDL: ${tab.title}`;
}

function tabTitle(tab: EditorTab): string {
  if (isConsole(tab)) {
    return `${tab.console}.sql`;
  }
  if (tab.kind === 'data') {
    return `Rows of ${tab.object.schema}.${tab.object.name}`;
  }
  return tab.kind === 'object'
    ? `${tab.object.schema}.${tab.object.name} (${tab.object.objectType.replace('_', ' ')})`
    : `Generated DDL for ${tab.title}`;
}

/** Marks a tab whose session has an open (or failed) transaction. */
function TabTxBadge({ tab }: { tab: ConsoleTab }) {
  const session = sessionOf(tab);
  const state = useTx((s) => (session ? s.states[keyOf(session)] : undefined));
  if (!state?.open || state.status === 'idle') {
    return null;
  }
  const failed = state.status === 'failed';
  return (
    <span
      className={clsx(
        'ml-1.5 rounded px-1 font-sans text-[10px] font-semibold',
        failed ? 'bg-danger text-danger-fg' : 'bg-accent text-accent-fg',
      )}
      aria-label={failed ? 'transaction failed' : 'transaction open'}
      title={failed ? 'The transaction failed; roll it back.' : 'A transaction is open.'}
    >
      TX
    </span>
  );
}

function ConsolePane({ tab, theme }: { tab: ConsoleTab; theme: 'light' | 'dark' }) {
  const keymap = useKeymap();
  const fontSize = useSettings((s) => s.settings.editorFontSize);
  const updateText = useWorkspace((s) => s.updateText);
  const setCaret = useWorkspace((s) => s.setCaret);
  const sources = useConnections((s) => s.items);
  const [formatError, setFormatError] = useState<string | null>(null);
  const running = useExec((s) => isRunning(s.runs[tab.id]));
  const cancel = useExec((s) => s.cancel);

  const onChange = useCallback(
    (text: string) => {
      setFormatError(null);
      updateText(tab.id, text);
    },
    [tab.id, updateText],
  );

  return (
    <div
      role="tabpanel"
      id="editor-tabpanel"
      aria-labelledby={`tab-${tab.id}`}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        role="toolbar"
        aria-label="Console toolbar"
        className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2 py-1 text-[12px] whitespace-nowrap"
      >
        <label className="flex items-center gap-1.5">
          <span className="text-muted">Data source</span>
          <select
            value={tab.sourceId ?? ''}
            onChange={(e) => void changeSource(tab.id, e.target.value || null)}
            className="max-w-48 rounded border border-border bg-bg px-1.5 py-0.5"
          >
            <option value="">None</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => void runFromEditor('current')}
          disabled={running}
          title={`Run statement or selection (${shortcutLabel('query.run', keymap)})`}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-success hover:bg-hover disabled:opacity-40"
        >
          <Play size={13} aria-hidden /> Run
        </button>
        <button
          type="button"
          onClick={() => void runFromEditor('script')}
          disabled={running}
          title={`Run whole console (${shortcutLabel('query.runScript', keymap)})`}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-40"
        >
          <ListChecks size={13} aria-hidden /> Run script
        </button>
        <button
          type="button"
          onClick={() => void cancel(tab.id)}
          disabled={!running}
          title={`Stop (${shortcutLabel('query.cancel', keymap)})`}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-danger hover:bg-hover disabled:opacity-40"
        >
          <Square size={12} aria-hidden /> Stop
        </button>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <button
          type="button"
          onClick={() => activeEditor()?.format()}
          title={`Format (${shortcutLabel('editor.format', keymap)})`}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover"
        >
          <AlignLeft size={13} aria-hidden /> Format
        </button>
        <TxControls tab={tab} />
        {formatError && (
          <span role="alert" className="min-w-0 truncate text-danger" title={formatError}>
            {formatError}
          </span>
        )}
        <span className="ml-auto text-muted" aria-live="polite">
          {tab.save === 'error' ? (
            <span className="text-danger">Not saved: {tab.saveError}</span>
          ) : tab.save === 'saved' ? (
            'Saved'
          ) : (
            'Saving…'
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1" data-action-context="editor">
        <SqlEditor
          tabId={tab.id}
          name={tab.console}
          value={tab.text}
          fontSize={fontSize}
          theme={theme}
          onChange={onChange}
          onCaret={setCaret}
          onFormatError={setFormatError}
        />
      </div>
    </div>
  );
}
