import { useEffect, useLayoutEffect, useRef } from 'react';
import EditorWorker from 'monaco-esm/editor/editor.worker.js?worker';
import * as monaco from './monaco/entry';
import { completionContextAt, tablesInStatement } from '../../lib/sql/completionContext';
import { formatSql } from '../../lib/sql/format';
import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { useSessions } from '../connections/sessionsStore';
import {
  catalogColumns,
  catalogFunctions,
  catalogLinks,
  catalogRelations,
  searchPathOf,
} from './catalog';
import { setActiveEditor, type SqlEditorProps } from './editorHandle';
import { buildSuggestions, type SuggestionKind } from './suggestions';
import { activeSnippets } from '../snippets/snippetsStore';
import { snippetText } from '../snippets/text';

// Workers are bundled locally (no CDN; the app CSP only allows 'self').
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

const css = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function defineThemes() {
  // Match the app's surface colors; token colors come from Monaco's built-in themes, except the
  // ones that fall below 4.5:1 contrast (WCAG AA) on our backgrounds, current line included.
  monaco.editor.defineTheme('quarry-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'string.sql', foreground: 'b31d1d' }, // was FF0000 (4.0:1)
      { token: 'operator.sql', foreground: '56626e' }, // was 778899 (3.6:1)
    ],
    colors: { 'editor.background': '#ffffff' },
  });
  monaco.editor.defineTheme('quarry-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'string.sql', foreground: 'ff8080' }, // was FF0000 (4.1:1)
      { token: 'comment', foreground: '7fb069' }, // was 608B4E (4.2:1)
      { token: 'variable.predefined', foreground: '8aa8e8' }, // was 4864AA (2.9:1)
    ],
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
    // New text uses LF; a file that already uses CRLF keeps it.
    if (!value.includes('\r\n')) {
      model.setEOL(monaco.editor.EndOfLineSequence.LF);
    }
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
  function: monaco.languages.CompletionItemKind.Function,
  join: monaco.languages.CompletionItemKind.Reference,
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
    const [relations, functions] = live
      ? await Promise.all([catalogRelations(sourceId), catalogFunctions(sourceId)])
      : [[], []];
    const items = await buildSuggestions(context, tablesInStatement(statement), {
      relations,
      functions,
      columnsOf: (r) =>
        live && r.detail ? catalogColumns(sourceId, r.detail, r.name) : Promise.resolve([]),
      linksOf: (r) =>
        live && r.detail ? catalogLinks(sourceId, r.detail, r.name) : Promise.resolve([]),
      // Unqualified names resolve through the console's schema first (REQ-EDIT-11).
      searchPath: searchPathOf(isConsole(tab) ? tab.schema : null),
    });
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(
      position.lineNumber,
      word.startColumn,
      position.lineNumber,
      word.endColumn,
    );
    // Snippets whose abbreviation starts with the typed word, where a statement or clause can
    // start (fuzzy matches on short abbreviations are mostly noise).
    const typed = word.word.toLowerCase();
    const snippets =
      context.kind === 'general' && typed
        ? activeSnippets().filter((s) => s.abbreviation.toLowerCase().startsWith(typed))
        : [];
    const snippetItems = snippets.map((s, i) => ({
      label: { label: s.abbreviation, description: s.description },
      kind: monaco.languages.CompletionItemKind.Snippet,
      insertText: s.body,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      detail: `Snippet: ${s.description}`,
      documentation: { value: ['```sql', snippetText(s.body).text, '```'].join('\n') },
      sortText: `!${String(i).padStart(5, '0')}`,
      filterText: word.word,
      range,
    }));
    // The list is already filtered and ranked (fuzzy, REQ-EDIT-07): Monaco keeps that order,
    // matches everything against the typed word, and asks again as typing continues.
    return {
      incomplete: true,
      suggestions: [
        ...snippetItems,
        ...items.map((s, i) => ({
          label: s.label,
          kind: KIND[s.kind],
          insertText: s.insertText,
          insertTextRules: s.snippet
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          detail: s.detail,
          sortText: String(i).padStart(6, '0'),
          filterText: word.word || s.label,
          range,
        })),
      ],
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
  readOnly = false,
}: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const callbacks = useRef({ onChange, onCaret, onFormatError, readOnly });
  // Keep the latest callbacks without recreating the editor (refs must not be written during render).
  useLayoutEffect(() => {
    callbacks.current = { onChange, onCaret, onFormatError, readOnly };
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
      // While a snippet is being filled in, Tab moves between its stops instead of accepting a
      // suggestion that typing opened.
      suggest: { snippetsPreventQuickSuggestions: true },
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
      // executeEdits would still change a read-only model.
      if (callbacks.current.readOnly) return;
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
    const model = () => editor.getModel();
    const toOffset = (p: { lineNumber: number; column: number }) => model()?.getOffsetAt(p) ?? 0;
    setActiveEditor({
      format,
      focus: () => editor.focus(),
      getText: () => editor.getValue(),
      getSelection: () => {
        const s = editor.getSelection();
        if (!s) return { start: 0, end: 0 };
        return { start: toOffset(s.getStartPosition()), end: toOffset(s.getEndPosition()) };
      },
      getCaret: () => toOffset(editor.getPosition() ?? { lineNumber: 1, column: 1 }),
      insertText: (text) => {
        const selection = editor.getSelection();
        if (!selection) {
          return;
        }
        editor.executeEdits('quarry-insert', [{ range: selection, text, forceMoveMarkers: true }]);
        editor.pushUndoStop();
        editor.focus();
      },
      expandSnippet: (lookup) => {
        const m = model();
        const position = editor.getPosition();
        const selection = editor.getSelection();
        if (!m || !position || !selection?.isEmpty() || callbacks.current.readOnly) {
          return false;
        }
        const word = m.getWordUntilPosition(position);
        const body = word.word ? lookup(word.word) : undefined;
        if (body === undefined || word.endColumn !== position.column) {
          return false;
        }
        editor.setSelection(
          new monaco.Selection(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          ),
        );
        // The snippet controller links the tab stops: Tab moves through them, Escape leaves.
        const controller = editor.getContribution('snippetController2') as {
          insert(template: string): void;
        } | null;
        if (!controller) {
          return false;
        }
        controller.insert(body);
        return true;
      },
      revealOffset: (offset) => {
        const m = model();
        if (!m) return;
        const p = m.getPositionAt(offset);
        editor.setPosition(p);
        editor.revealPositionInCenterIfOutsideViewport(p);
        editor.focus();
      },
      markError: (start, end, message) => {
        const m = model();
        if (!m) return;
        const from = m.getPositionAt(start);
        const to = m.getPositionAt(Math.max(end, start + 1));
        monaco.editor.setModelMarkers(m, 'quarry-exec', [
          {
            severity: monaco.MarkerSeverity.Error,
            message,
            startLineNumber: from.lineNumber,
            startColumn: from.column,
            endLineNumber: to.lineNumber,
            endColumn: to.column,
          },
        ]);
      },
      clearMarkers: () => {
        const m = model();
        if (m) monaco.editor.setModelMarkers(m, 'quarry-exec', []);
      },
      errors: () => {
        const m = model();
        if (!m) {
          return [];
        }
        return monaco.editor
          .getModelMarkers({ owner: 'quarry-exec', resource: m.uri })
          .map((k) => ({
            start: m.getOffsetAt({ lineNumber: k.startLineNumber, column: k.startColumn }),
            end: m.getOffsetAt({ lineNumber: k.endLineNumber, column: k.endColumn }),
            message: k.message,
          }))
          .sort((a, b) => a.start - b.start);
      },
    });

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
    () => editorRef.current?.updateOptions({ readOnly, domReadOnly: readOnly }),
    [readOnly],
  );
  useEffect(
    () => monaco.editor.setTheme(theme === 'dark' ? 'quarry-dark' : 'quarry-light'),
    [theme],
  );

  return <div ref={host} className="h-full w-full" data-testid="monaco-host" />;
}
