import { useEffect, useId, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
}

/** Accessible modal: focuses itself on open, closes on Escape, restores focus on close, traps Tab. */
export function Modal({ title, onClose, children, footer }: Props) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(
      'input, select, button, textarea, [tabindex="0"]',
    );
    (first ?? ref.current)?.focus();
    return () => previouslyFocused?.focus();
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

  return (
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
        className="w-[440px] max-w-[90vw] rounded-md border border-border bg-panel shadow-xl"
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
    </div>
  );
}
