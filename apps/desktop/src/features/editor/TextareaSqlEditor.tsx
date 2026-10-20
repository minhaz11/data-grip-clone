import { useEffect, useRef } from 'react';
import { formatSql } from '../../lib/sql/format';
import { setActiveEditor, type SqlEditorProps } from './editorHandle';

/** 1-based line/column of a caret offset. */
export function caretPosition(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lastNewline = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastNewline };
}

/**
 * Plain-text stand-in for the Monaco editor with the same props. Used where Monaco cannot run
 * (jsdom tests); production renders `MonacoSqlEditor`.
 */
export default function TextareaSqlEditor({
  name,
  value,
  fontSize,
  onChange,
  onCaret,
  onFormatError,
}: SqlEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = () => ref.current;
    setActiveEditor({
      focus: () => el()?.focus(),
      getText: () => el()?.value ?? '',
      getSelection: () => ({ start: el()?.selectionStart ?? 0, end: el()?.selectionEnd ?? 0 }),
      getCaret: () => el()?.selectionStart ?? 0,
      revealOffset: (offset) => {
        el()?.setSelectionRange(offset, offset);
        el()?.focus();
      },
      // The plain editor cannot underline; it exposes the marker for tests and assistive tech.
      markError: (start, end, message) => {
        el()?.setAttribute('data-error', `${start}-${end}`);
        el()?.setAttribute('aria-description', message);
      },
      clearMarkers: () => {
        el()?.removeAttribute('data-error');
        el()?.removeAttribute('aria-description');
      },
      format: () => {
        try {
          onChange(formatSql(ref.current?.value ?? ''));
        } catch (e) {
          onFormatError(e instanceof Error ? e.message : String(e));
        }
      },
    });
    return () => setActiveEditor(null);
  }, [onChange, onFormatError]);

  const report = (el: HTMLTextAreaElement) => onCaret(caretPosition(el.value, el.selectionStart));
  return (
    <textarea
      ref={ref}
      aria-label={`${name} SQL`}
      value={value}
      spellCheck={false}
      // Mounted per tab (keyed by id), so opening or switching a console puts the caret in it.
      autoFocus
      onChange={(e) => {
        onChange(e.target.value);
        report(e.target);
      }}
      onSelect={(e) => report(e.currentTarget)}
      onFocus={(e) => report(e.currentTarget)}
      style={{ fontSize }}
      className="h-full w-full resize-none bg-bg p-3 font-mono leading-relaxed text-fg outline-none select-text"
    />
  );
}
