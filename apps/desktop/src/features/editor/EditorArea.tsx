import clsx from 'clsx';
import { AlignLeft, ListChecks, Play, Square, X } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useSettings } from '../../app/settingsStore';
import { useWorkspace, type ConsoleTab } from '../../app/workspaceStore';
import { shortcutLabel } from '../../lib/keymap';
import { useConnections } from '../connections/connectionsStore';
import { effectiveColor } from '../connections/model';
import { activeEditor } from './editorHandle';
import { SqlEditor } from './SqlEditor';
import { isRunning, useExec } from '../exec/execStore';
import { runFromEditor } from '../exec/runQuery';

export function EditorArea({ theme }: { theme: 'light' | 'dark' }) {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const activate = useWorkspace((s) => s.activate);
  const closeTab = useWorkspace((s) => s.closeTab);
  const newConsole = useWorkspace((s) => s.newConsole);
  const sources = useConnections((s) => s.items);
  const selectedSourceId = useConnections((s) => s.selectedId);
  const active = tabs.find((t) => t.id === activeTabId);

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
          New console <span className="text-muted">({shortcutLabel('console.new')})</span>
        </button>
      </section>
    );
  }

  return (
    <section aria-label="Editor" className="flex h-full flex-col bg-bg">
      <div
        role="tablist"
        aria-label="Open consoles"
        className="flex h-8 shrink-0 overflow-x-auto border-b border-border bg-panel"
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
            >
              <button
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={selected}
                aria-controls="editor-tabpanel"
                tabIndex={selected ? 0 : -1}
                onClick={() => activate(tab.id)}
                title={[
                  `${tab.console}.sql`,
                  source && `Data source: ${source.name}`,
                  tab.saveError,
                ]
                  .filter(Boolean)
                  .join('\n')}
                className="h-full pl-3 pr-1 font-mono text-[12px]"
              >
                {tab.console}.sql
                {tab.save === 'error' && (
                  <span className="ml-1 text-danger" aria-label="save failed">
                    !
                  </span>
                )}
                {(tab.save === 'pending' || tab.save === 'saving') && (
                  <span className="ml-1" aria-label="unsaved changes">
                    •
                  </span>
                )}
              </button>
              {/* Mouse affordance only: a tablist may contain only tabs, so keyboard and screen-reader
                  users close the active tab with the tab.close shortcut instead. */}
              <button
                type="button"
                tabIndex={-1}
                aria-hidden
                title={`Close (${shortcutLabel('tab.close')})`}
                onClick={() => void closeTab(tab.id)}
                className="mr-1 rounded p-0.5 opacity-60 hover:bg-hover hover:opacity-100"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      {active && <ConsolePane key={active.id} tab={active} theme={theme} />}
    </section>
  );
}

function ConsolePane({ tab, theme }: { tab: ConsoleTab; theme: 'light' | 'dark' }) {
  const fontSize = useSettings((s) => s.settings.editorFontSize);
  const updateText = useWorkspace((s) => s.updateText);
  const setSource = useWorkspace((s) => s.setSource);
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
        className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2 text-[12px]"
      >
        <label className="flex items-center gap-1.5">
          <span className="text-muted">Data source</span>
          <select
            value={tab.sourceId ?? ''}
            onChange={(e) => setSource(tab.id, e.target.value || null)}
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
          title={`Run statement or selection (${shortcutLabel('query.run')})`}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-success hover:bg-hover disabled:opacity-40"
        >
          <Play size={13} aria-hidden /> Run
        </button>
        <button
          type="button"
          onClick={() => void runFromEditor('script')}
          disabled={running}
          title={`Run whole console (${shortcutLabel('query.runScript')})`}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-40"
        >
          <ListChecks size={13} aria-hidden /> Run script
        </button>
        <button
          type="button"
          onClick={() => void cancel(tab.id)}
          disabled={!running}
          title={`Stop (${shortcutLabel('query.cancel')})`}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-danger hover:bg-hover disabled:opacity-40"
        >
          <Square size={12} aria-hidden /> Stop
        </button>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <button
          type="button"
          onClick={() => activeEditor()?.format()}
          title={`Format (${shortcutLabel('editor.format')})`}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover"
        >
          <AlignLeft size={13} aria-hidden /> Format
        </button>
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
      <div className="min-h-0 flex-1">
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
