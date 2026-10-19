import { useEffect, useRef } from 'react';

export interface MenuItem {
  label: string;
  shortcut?: string;
  danger?: boolean;
  onSelect(): void;
}

interface Props {
  x: number;
  y: number;
  label: string;
  items: MenuItem[];
  onClose(): void;
}

/** Keyboard-navigable context menu (Up/Down/Home/End, Enter, Escape); closes on outside click. */
export function ContextMenu({ x, y, label, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  function onKeyDown(e: React.KeyboardEvent) {
    const entries = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => entries[(i + entries.length) % entries.length]?.focus();
    if (e.key === 'ArrowDown') focus(index + 1);
    else if (e.key === 'ArrowUp') focus(index - 1);
    else if (e.key === 'Home') focus(0);
    else if (e.key === 'End') focus(entries.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') onClose();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={{ left: x, top: y }}
      className="fixed z-50 min-w-48 rounded-md border border-border bg-panel py-1 shadow-lg"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          className={`flex w-full items-center justify-between gap-6 px-3 py-1 text-left hover:bg-hover focus:bg-selected focus:outline-none ${item.danger ? 'text-danger' : ''}`}
        >
          <span>{item.label}</span>
          {item.shortcut && <span className="text-[11px] text-muted">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}
