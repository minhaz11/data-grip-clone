import { useState, type ReactNode } from 'react';
import { Modal } from './Modal';

export interface Choice {
  label: string;
  danger?: boolean;
  /** Runs while the dialog shows "Working…"; a thrown error is shown and the dialog stays open. */
  run(): Promise<void>;
}

interface Props {
  title: string;
  children: ReactNode;
  choices: Choice[];
  onDone(): void;
  onCancel(): void;
}

/** Several ways to proceed plus Cancel. Focus starts on Cancel so Enter never picks an action. */
export function ChoiceDialog({ title, children, choices, onDone, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(choice: Choice) {
    setBusy(true);
    setError(null);
    try {
      await choice.run();
      onDone();
    } catch (e) {
      const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
      setError(message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={onCancel}
      initialFocus="[data-autofocus]"
      footer={
        <>
          <button
            type="button"
            data-autofocus
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Cancel
          </button>
          {choices.map((c) => (
            <button
              key={c.label}
              type="button"
              onClick={() => void choose(c)}
              disabled={busy}
              className={`rounded px-3 py-1 disabled:opacity-50 ${c.danger ? 'bg-danger text-danger-fg' : 'bg-accent text-accent-fg'}`}
            >
              {c.label}
            </button>
          ))}
        </>
      }
    >
      <div className="space-y-2">{children}</div>
      {busy && (
        <p role="status" className="mt-3 text-muted">
          Working…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
