import { useSettings } from '../../app/settingsStore';
import { useWorkspace } from '../../app/workspaceStore';

/** 1-based line/column of a caret offset. */
export function caretPosition(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastNewline };
}

/**
 * Interim text surface for SQL consoles. M3.1 replaces it with Monaco (highlighting, completion);
 * the tab/text contract with the workspace store stays the same.
 */
export function PlainSqlEditor({
  tabId,
  text,
  label,
}: {
  tabId: string;
  text: string;
  label: string;
}) {
  const fontSize = useSettings((s) => s.settings.editorFontSize);
  const updateText = useWorkspace((s) => s.updateText);
  const setCaret = useWorkspace((s) => s.setCaret);

  const reportCaret = (el: HTMLTextAreaElement) =>
    setCaret(caretPosition(el.value, el.selectionStart));

  return (
    <textarea
      aria-label={label}
      value={text}
      // Mounted per tab (keyed by id), so opening or switching a console puts the caret in it.
      autoFocus
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      onChange={(e) => {
        updateText(tabId, e.target.value);
        reportCaret(e.target);
      }}
      onSelect={(e) => reportCaret(e.currentTarget)}
      onFocus={(e) => reportCaret(e.currentTarget)}
      style={{ fontSize }}
      className="h-full w-full resize-none bg-bg p-3 font-mono leading-relaxed text-fg outline-none select-text"
    />
  );
}
