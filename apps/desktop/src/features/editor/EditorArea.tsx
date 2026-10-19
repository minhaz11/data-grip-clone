import clsx from 'clsx';
import { X } from 'lucide-react';
import { useWorkspace } from '../../app/workspaceStore';
import { shortcutLabel } from '../../lib/keymap';
import { PlainSqlEditor } from './PlainSqlEditor';

export function EditorArea() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const activate = useWorkspace((s) => s.activate);
  const closeTab = useWorkspace((s) => s.closeTab);
  const newConsole = useWorkspace((s) => s.newConsole);
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
          onClick={() => newConsole()}
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
              onAuxClick={(e) => e.button === 1 && closeTab(tab.id)}
            >
              <button
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={selected}
                aria-controls="editor-tabpanel"
                tabIndex={selected ? 0 : -1}
                onClick={() => activate(tab.id)}
                className="h-full pl-3 pr-1 font-mono text-[12px]"
              >
                {tab.title}.sql
              </button>
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                title={`Close (${shortcutLabel('tab.close')})`}
                onClick={() => closeTab(tab.id)}
                className="mr-1 rounded p-0.5 opacity-60 hover:bg-hover hover:opacity-100"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
      {active && (
        <div
          role="tabpanel"
          id="editor-tabpanel"
          aria-labelledby={`tab-${active.id}`}
          className="min-h-0 flex-1"
        >
          <PlainSqlEditor
            key={active.id}
            tabId={active.id}
            text={active.text}
            label={`${active.title} SQL`}
          />
        </div>
      )}
    </section>
  );
}
