import { useId, type ReactNode } from 'react';
import { backend } from '../../ipc/client';
import type { FilePurpose } from '../../ipc/types';
import { toAppError } from '../../lib/errors';

export const field =
  'rounded border border-border bg-bg px-2 py-1 aria-[invalid=true]:border-danger';
export const input = `${field} w-full`;

/** A labelled row of the dialog's two-column grid, with an optional error under the control. */
export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children(id: string, describedBy?: string): ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <>
      <label htmlFor={id} className="pt-1">
        {label}
      </label>
      <div>
        {children(id, error ? errorId : undefined)}
        {error && (
          <p id={errorId} className="mt-0.5 text-[12px] text-danger">
            {error}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * A file path: typed, or chosen with the native dialog (from Rust). Only the path is stored; the
 * file is read when connecting.
 */
export function PathField({
  label,
  value,
  purpose,
  error,
  placeholder,
  onChange,
  onError,
}: {
  label: string;
  value: string | null;
  purpose: FilePurpose;
  error?: string;
  placeholder?: string;
  onChange(path: string | null): void;
  onError(message: string): void;
}) {
  async function browse() {
    try {
      const picked = await backend.filePick(purpose);
      if (picked !== null) {
        onChange(picked);
      }
    } catch (e) {
      onError(toAppError(e).message);
    }
  }
  return (
    <Field label={label} error={error}>
      {(id, describedBy) => (
        <div className="flex gap-2">
          <input
            id={id}
            className={input}
            value={value ?? ''}
            placeholder={placeholder ?? 'None'}
            spellCheck={false}
            aria-invalid={!!error}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.value || null)}
          />
          <button
            type="button"
            onClick={() => void browse()}
            aria-label={`Browse for ${label}`}
            className="shrink-0 rounded border border-border px-2 py-1 hover:bg-hover"
          >
            Browse…
          </button>
          {value && (
            <button
              type="button"
              onClick={() => onChange(null)}
              aria-label={`Clear ${label}`}
              className="shrink-0 text-[12px] text-muted underline"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </Field>
  );
}

/** A whole number input; empty or invalid text becomes `NaN` so validation can flag it. */
export function NumberInput({
  id,
  value,
  min,
  max,
  invalid,
  describedBy,
  label,
  onChange,
}: {
  id: string;
  /** Accessible name when no `<label>` points at `id`. */
  label?: string;
  value: number;
  min: number;
  max: number;
  invalid?: boolean;
  describedBy?: string;
  onChange(value: number): void;
}) {
  return (
    <input
      id={id}
      type="number"
      min={min}
      max={max}
      className={`${field} w-24 shrink-0`}
      aria-label={label}
      aria-invalid={invalid}
      aria-describedby={describedBy}
      value={Number.isNaN(value) ? '' : value}
      onChange={(e) => onChange(e.target.valueAsNumber)}
    />
  );
}
