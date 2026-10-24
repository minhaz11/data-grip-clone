import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Element to focus on open; defaults to the first focusable control. */
  initialFocus?: string;
}

/**
 * Accessible modal: focuses itself on open, closes on Escape, restores focus on close, traps Tab.
 * Rendered into `document.body`, so the panel it is opened from cannot clip it or take its
 * pointer events (resize handles listen across their panel group).
 */
export function Modal({ title, onClose, children, footer, width = 440, initialFocus }: Props) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(
      initialFocus ?? 'input, select, button, textarea, [tabindex="0"]',
    );
    (first ?? ref.current)?.focus();
    return () => previouslyFocused?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus once on open
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Tab' && ref.current) {
      const focusable = [
        ...ref.current.querySelectorAll<HTMLElement>(
          'input, select, button, textarea, [tabindex="0"]',
        ),
      ];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={onClose}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ width }}
        className="max-h-[90vh] max-w-[92vw] overflow-auto rounded-md border border-border bg-panel shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="border-b border-border px-4 py-2.5 text-[13px] font-semibold">
          {title}
        </h2>
        <div className="px-4 py-3">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
