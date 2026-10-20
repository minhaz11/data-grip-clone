/** The focused/visible editor's imperative API, so toolbar buttons and global shortcuts can act on it. */
export interface EditorHandle {
  format(): void;
  focus(): void;
}

let active: EditorHandle | null = null;

export function setActiveEditor(handle: EditorHandle | null) {
  active = handle;
}

export function activeEditor(): EditorHandle | null {
  return active;
}

export interface SqlEditorProps {
  tabId: string;
  /** Console name, for labels and model URIs. */
  name: string;
  value: string;
  fontSize: number;
  theme: 'light' | 'dark';
  onChange(text: string): void;
  onCaret(caret: { line: number; column: number } | null): void;
  /** Formatting failed (e.g. text the formatter cannot parse). */
  onFormatError(message: string): void;
}
