import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  children: ReactNode;
}

/** Icon-only button: the label is always exposed to assistive tech and shown as a tooltip. */
export function IconButton({ label, shortcut, pressed, className, children, ...rest }: Props) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={clsx(
        'inline-flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:opacity-40',
        pressed && 'bg-selected text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
