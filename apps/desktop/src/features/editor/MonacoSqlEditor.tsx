import { useEffect, useLayoutEffect, useRef } from 'react';
import EditorWorker from 'monaco-esm/editor/editor.worker.js?worker';
import * as monaco from './monaco/entry';
import { completionContextAt, tablesInStatement } from '../../lib/sql/completionContext';
import { formatSql } from '../../lib/sql/format';
import { useWorkspace } from '../../app/workspaceStore';
import { useSessions } from '../connections/sessionsStore';
import { catalogColumns, catalogRelations } from './catalog';
import { setActiveEditor, type SqlEditorProps } from './editorHandle';
import { buildSuggestions, type SuggestionKind } from './suggestions';

// Workers are bundled locally (no CDN; the app CSP only allows 'self').
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function defineThemes() {
  // Match the app's surface colors; token colors come from Monaco's built-in themes.
  monaco.editor.defineTheme('quarry-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#ffffff' },
  });
  monaco.editor.defineTheme('quarry-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#1e1f22' },
  });
}
defineThemes();

/** One model per console tab keeps undo history and view state across tab switches. */
const models = new Map<string, monaco.editor.ITextModel>();
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
const tabOfModel = new WeakMap<monaco.editor.ITextModel, string>();

function modelFor(tabId: string, name: string, value: string) {
  let model = models.get(tabId);
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(
      value,
      'pgsql',
      monaco.Uri.parse(`inmemory://console/${tabId}/${encodeURIComponent(name)}.sql`),
    );
    models.set(tabId, model);
    tabOfModel.set(model, tabId);
  }
  return model;
}

// Dispose models of closed tabs.
useWorkspace.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return;
  const open = new Set(s.tabs.map((t) => t.id));
  for (const [id, model] of models) {
    if (!open.has(id)) {
      model.dispose();
      models.delete(id);
      viewStates.delete(id);
    }
  }
});

const KIND: Record<SuggestionKind, monaco.languages.CompletionItemKind> = {
  keyword: monaco.languages.CompletionItemKind.Keyword,
  schema: monaco.languages.CompletionItemKind.Module,
  table: monaco.languages.CompletionItemKind.Struct,
  view: monaco.languages.CompletionItemKind.Interface,
  column: monaco.languages.CompletionItemKind.Field,
};

monaco.languages.registerCompletionItemProvider('pgsql', {
  triggerCharacters: ['.'],
  async provideCompletionItems(model, position) {
    const offset = model.getOffsetAt(position);
    const { context, statement } = completionContextAt(model.getValue(), offset);
    const tab = useWorkspace.getState().tabs.find((t) => t.id === tabOfModel.get(model));
    const sourceId = tab?.sourceId ?? null;
    // Completion never connects on its own; without a live session it offers keywords only.
    const live = sourceId !== null && useSessions.getState().byId[sourceId]?.state === 'connected';
    const relations = live ? await catalogRelations(sourceId) : [];
    const items = await buildSuggestions(context, tablesInStatement(statement), {
      relations,
      columnsOf: (r) =>
        live && r.detail ? catalogColumns(sourceId, r.detail, r.name) : Promise.resolve([]),
    });
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(
      position.lineNumber,
      word.startColumn,
      position.lineNumber,
      word.endColumn,
    );
    return {
      suggestions: items.map((s) => ({
        label: s.label,
        kind: KIND[s.kind],
        insertText: s.insertText,
        detail: s.detail,
        sortText: `${s.rank}${s.label.toLowerCase()}`,
        range,
      })),
    };
  },
});

export default function MonacoSqlEditor({
  tabId,
  name,
  value,
  fontSize,
  theme,
  onChange,
  onCaret,
  onFormatError,
}: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callbacks = useRef({ onChange, onCaret, onFormatError });
  // Keep the latest callbacks without recreating the editor (refs must not be written during render).
  useLayoutEffect(() => {
    callbacks.current = { onChange, onCaret, onFormatError };
  });

  // Create the editor once.
  useEffect(() => {
    if (!host.current) return;
    const editor = monaco.editor.create(host.current, {
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: css('--font-mono') || 'monospace',
      tabSize: 2,
      wordBasedSuggestions: 'off',
      quickSuggestions: { other: true, comments: false, strings: false },
      renderLineHighlight: 'line',
      fixedOverflowWidgets: true,
      ariaLabel: 'SQL editor',
    });
    editorRef.current = editor;
    const subs = [
      editor.onDidChangeModelContent(() => callbacks.current.onChange(editor.getValue())),
      editor.onDidChangeCursorPosition((e) =>
        callbacks.current.onCaret({ line: e.position.lineNumber, column: e.position.column }),
      ),
    ];

    const format = () => {
      const model = editor.getModel();
      const selection = editor.getSelection();
      if (!model || !selection) return;
      const range = selection.isEmpty() ? model.getFullModelRange() : selection;
      try {
        const formatted = formatSql(model.getValueInRange(range));
        // executeEdits keeps the change on the undo stack (Ctrl+Z restores the original).
        editor.executeEdits('quarry-format', [{ range, text: formatted }]);
        editor.pushUndoStop();
      } catch (e) {
        callbacks.current.onFormatError(e instanceof Error ? e.message : String(e));
      }
    };
    setActiveEditor({ format, focus: () => editor.focus() });

    return () => {
      subs.forEach((s) => s.dispose());
      setActiveEditor(null);
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // Switch models when the active tab changes, keeping each tab's cursor and scroll position.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = modelFor(tabId, name, value);
    if (editor.getModel() !== model) {
      const previous = editor.getModel();
      const previousTab = previous ? tabOfModel.get(previous) : undefined;
      if (previousTab) viewStates.set(previousTab, editor.saveViewState());
      editor.setModel(model);
      const state = viewStates.get(tabId);
      if (state) editor.restoreViewState(state);
      editor.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `value` only seeds a new model
  }, [tabId, name]);

  // External text changes (not typed here) replace the model content.
  useEffect(() => {
    const model = models.get(tabId);
    if (model && !model.isDisposed() && model.getValue() !== value) model.setValue(value);
  }, [tabId, value]);

  useEffect(() => editorRef.current?.updateOptions({ fontSize }), [fontSize]);
  useEffect(
    () => monaco.editor.setTheme(theme === 'dark' ? 'quarry-dark' : 'quarry-light'),
    [theme],
  );

  return <div ref={host} className="h-full w-full" data-testid="monaco-host" />;
}
