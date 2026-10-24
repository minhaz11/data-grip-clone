import { useMemo, useState } from 'react';
import { StatusBar } from './StatusBar';
import { Toolbar } from './Toolbar';
import { Workbench } from './Workbench';
import { useAppliedTheme, useKeybindings, useWorkspacePersistence } from './hooks';
import { isConsole, useWorkspace } from './workspaceStore';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { useConnections } from '../features/connections/connectionsStore';
import { activeEditor, goToError } from '../features/editor/editorHandle';
import { snippetFor } from '../features/snippets/snippetsStore';
import { useExec } from '../features/exec/execStore';
import { runFromEditor } from '../features/exec/runQuery';
import { closeConsole } from '../features/exec/txGuards';
import { DialogHost } from './dialogs';
import { Toasts } from '../features/notifications/notifications';
import { ConnectionDialog } from '../features/connections/ConnectionDialog';
import { HistoryDialog } from '../features/history/HistoryDialog';
import { goToDdlAtCaret, revealAtCaret } from '../features/navigation/atCaret';
import { formatWithHistory } from '../features/editor/localHistory';
import { LocalHistoryDialog } from '../features/editor/LocalHistoryDialog';
import { AskAiDialog } from '../features/ai/AskAiDialog';
import { aiAvailable, useAi } from '../features/ai/aiStore';
import { statementAt } from '../lib/sql/statements';
import { useNotifications } from '../features/notifications/notifications';
import { Palette } from '../features/palette/Palette';
import { RecentDialog } from '../features/palette/RecentDialog';
import type { ConnectionProfile } from '../ipc/types';
import type { ActionId } from '../lib/actions';
import { goBack, goForward } from './navStore';

/** Shows why a navigation action did nothing. */
async function explain(result: Promise<string | null>) {
  const problem = await result;
  if (problem) {
    useNotifications.getState().notify(problem);
  }
}

// Panels as they were before Hide all panels, to restore them.
let panelsBefore: { explorer: boolean; bottom: boolean } | null = null;

export function App() {
  const { ready, error } = useWorkspacePersistence();
  const theme = useAppliedTheme();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // The search palette's initial text (`null` = closed).
  const [palette, setPalette] = useState<string | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  // The console tab whose local history is open.
  const [localHistory, setLocalHistory] = useState<string | null>(null);
  const [askAi, setAskAi] = useState<{
    sourceId: string;
    sql: string;
    schema: string | null;
  } | null>(null);
  // AI entry points are hidden while AI is off, for this workspace, or without a key.
  const aiOn = useAi((s) => aiAvailable(s.status));
  const notices = useWorkspace((s) => s.notices);
  const dismissNotices = useWorkspace((s) => s.dismissNotices);
  // `null` = closed, `'new'` = create, profile = edit.
  const [connectionDialog, setConnectionDialog] = useState<ConnectionProfile | 'new' | null>(null);

  const handlers = useMemo(() => {
    const ws = () => useWorkspace.getState();
    return {
      'console.new': () => void ws().newConsole(useConnections.getState().selectedId),
      'tab.close': () => {
        const id = ws().activeTabId;
        if (id) void closeConsole(id);
      },
      'tab.next': () => ws().cycleTab(1),
      'tab.previous': () => ws().cycleTab(-1),
      'view.toggleExplorer': () => ws().setExplorerCollapsed(!ws().explorerCollapsed),
      'view.toggleBottomPanel': () => ws().setBottomCollapsed(!ws().bottomCollapsed),
      'settings.open': () => setSettingsOpen(true),
      'datasource.new': () => setConnectionDialog('new'),
      'editor.format': () => void formatWithHistory(),
      // Declines (false) unless the word before the caret is an abbreviation: Tab then indents
      // or accepts a suggestion, or moves to the next tab stop of an expanded snippet.
      'editor.expandSnippet': () =>
        activeEditor()?.expandSnippet((word) => snippetFor(word)?.body) ?? false,
      'editor.nextError': () => goToError(1),
      'editor.previousError': () => goToError(-1),
      'query.run': () => void runFromEditor('current'),
      'query.runScript': () => void runFromEditor('script'),
      'query.cancel': () => {
        const id = ws().activeTabId;
        if (id) void useExec.getState().cancel(id);
      },
      'history.open': () => setHistoryOpen(true),
      'search.everywhere': () => setPalette(''),
      'search.objects': () => setPalette('/objects '),
      'nav.recent': () => setRecentOpen(true),
      'nav.back': () => void goBack(),
      'nav.forward': () => void goForward(),
      'tab.reopenClosed': () => void ws().reopenClosed(),
      'view.hideAllPanels': () => {
        const { explorerCollapsed, bottomCollapsed } = ws();
        if (explorerCollapsed && bottomCollapsed && panelsBefore) {
          ws().setExplorerCollapsed(panelsBefore.explorer);
          ws().setBottomCollapsed(panelsBefore.bottom);
          panelsBefore = null;
        } else {
          panelsBefore = { explorer: explorerCollapsed, bottom: bottomCollapsed };
          ws().setExplorerCollapsed(true);
          ws().setBottomCollapsed(true);
        }
      },
      'ai.ask': () => {
        if (!aiAvailable()) {
          useNotifications
            .getState()
            .notify('AI is off. Turn it on and add an API key in Settings > AI.');
          return;
        }
        const tab = ws().tabs.find((t) => t.id === ws().activeTabId);
        const editor = activeEditor();
        if (!isConsole(tab) || !editor) {
          useNotifications.getState().notify('Ask AI works in a console.');
          return;
        }
        if (!tab.sourceId) {
          useNotifications.getState().notify('Choose a data source for this console first.');
          return;
        }
        const text = editor.getText();
        const selection = editor.getSelection();
        const span = statementAt(text, editor.getCaret());
        const sql =
          selection.end > selection.start
            ? text.slice(selection.start, selection.end)
            : span
              ? text.slice(span.start, span.end)
              : '';
        setAskAi({ sourceId: tab.sourceId, sql, schema: tab.schema ?? null });
      },
      'console.localHistory': () => {
        const tab = ws().tabs.find((t) => t.id === ws().activeTabId);
        if (isConsole(tab)) {
          setLocalHistory(tab.id);
        }
      },
      'editor.goToDdl': () => void explain(goToDdlAtCaret()),
      'editor.revealInTree': () => void explain(revealAtCaret()),
    } satisfies Partial<Record<ActionId, () => unknown>>;
  }, []);
  useKeybindings(handlers);

  if (!ready) {
    return (
      <div role="status" className="flex h-full items-center justify-center text-muted">
        Loading workspace…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenHistory={() => setHistoryOpen(true)}
      />
      {error && (
        <div role="alert" className="border-b border-border bg-panel-2 px-3 py-1 text-danger">
          {error}
        </div>
      )}
      {notices.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-border bg-panel-2 px-3 py-1 text-danger"
        >
          <span className="flex-1">{notices.join(' ')}</span>
          <button type="button" className="text-muted underline" onClick={dismissNotices}>
            Dismiss
          </button>
        </div>
      )}
      <Workbench
        theme={theme}
        onNewConnection={() => setConnectionDialog('new')}
        onEditConnection={setConnectionDialog}
      />
      <StatusBar theme={theme} />
      <DialogHost />
      <Toasts />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {historyOpen && <HistoryDialog onClose={() => setHistoryOpen(false)} />}
      {palette !== null && (
        <Palette
          initial={palette}
          actions={
            Object.keys(handlers).filter(
              (id) =>
                id !== 'search.everywhere' && id !== 'search.objects' && (aiOn || id !== 'ai.ask'),
            ) as ActionId[]
          }
          onRunAction={(id) => handlers[id as keyof typeof handlers]?.()}
          onClose={() => setPalette(null)}
        />
      )}
      {recentOpen && <RecentDialog onClose={() => setRecentOpen(false)} />}
      {askAi && (
        <AskAiDialog
          sourceId={askAi.sourceId}
          sql={askAi.sql}
          schema={askAi.schema}
          onClose={() => setAskAi(null)}
        />
      )}
      {localHistory && (
        <LocalHistoryDialog tabId={localHistory} onClose={() => setLocalHistory(null)} />
      )}
      {connectionDialog && (
        <ConnectionDialog
          profile={connectionDialog === 'new' ? undefined : connectionDialog}
          onClose={() => setConnectionDialog(null)}
        />
      )}
    </div>
  );
}
