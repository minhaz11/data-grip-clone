import { useEffect, useRef } from 'react';
import { formatSql } from '../../lib/sql/format';
import { snippetText } from '../snippets/text';
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
  readOnly = false,
}: SqlEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = () => ref.current;
    setActiveEditor({
      focus: () => el()?.focus(),
      getText: () => el()?.value ?? '',
      getSelection: () => ({ start: el()?.selectionStart ?? 0, end: el()?.selectionEnd ?? 0 }),
      getCaret: () => el()?.selectionStart ?? 0,
      insertText: (text) => {
        const area = el();
        if (!area || readOnly) {
          return;
        }
        const { selectionStart: start, selectionEnd: end, value } = area;
        onChange(value.slice(0, start) + text + value.slice(end));
        // The new value renders on the next frame; put the caret after the inserted text then.
        requestAnimationFrame(() => {
          area.setSelectionRange(start + text.length, start + text.length);
          area.focus();
        });
      },
      revealOffset: (offset) => {
        el()?.setSelectionRange(offset, offset);
        el()?.focus();
      },
      // The plain editor cannot underline; it exposes the marker for tests and assistive tech.
      markError: (start, end, message) => {
        el()?.setAttribute('data-error', `${start}-${end}`);
        el()?.setAttribute('aria-description', message);
        el()?.setAttribute('title', message);
      },
      clearMarkers: () => {
        el()?.removeAttribute('data-error');
        el()?.removeAttribute('aria-description');
        el()?.removeAttribute('title');
      },
      errors: () => {
        const range = /^(\d+)-(\d+)$/.exec(el()?.getAttribute('data-error') ?? '');
        return range
          ? [
              {
                start: Number(range[1]),
                end: Number(range[2]),
                message: el()?.getAttribute('aria-description') ?? '',
              },
            ]
          : [];
      },
      // Plain text has no linked tab stops: the first one is selected after expanding.
      expandSnippet: (lookup) => {
        const area = el();
        if (!area || readOnly || area.selectionStart !== area.selectionEnd) {
          return false;
        }
        const { selectionStart: at, value } = area;
        const word = /[A-Za-z_][\w]*$/.exec(value.slice(0, at))?.[0];
        const body = word ? lookup(word) : undefined;
        if (!word || body === undefined) {
          return false;
        }
        const { text, stops } = snippetText(body);
        const start = at - word.length;
        onChange(value.slice(0, start) + text + value.slice(at));
        const first = stops[0] ?? { start: text.length, end: text.length };
        requestAnimationFrame(() => {
          area.setSelectionRange(start + first.start, start + first.end);
          area.focus();
        });
        return true;
      },
      format: () => {
        if (readOnly) {
          return;
        }
        try {
          onChange(formatSql(ref.current?.value ?? ''));
        } catch (e) {
          onFormatError(e instanceof Error ? e.message : String(e));
        }
      },
    });
    return () => setActiveEditor(null);
  }, [onChange, onFormatError, readOnly]);

  const report = (el: HTMLTextAreaElement) => onCaret(caretPosition(el.value, el.selectionStart));
  return (
    <textarea
      ref={ref}
      aria-label={`${name} SQL`}
      value={value}
      readOnly={readOnly}
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
