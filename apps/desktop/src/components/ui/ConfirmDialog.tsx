import { useState, type ReactNode } from 'react';
import { Modal } from './Modal';

interface Props {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): Promise<void>;
  onClose(): void;
}

/** Confirmation for irreversible actions. Focus starts on Cancel so Enter never destroys by default. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      initialFocus="[data-autofocus]"
      footer={
        <>
          <button
            type="button"
            data-autofocus
            onClick={onClose}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className={`rounded px-3 py-1 disabled:opacity-50 ${danger ? 'bg-danger text-danger-fg' : 'bg-accent text-accent-fg'}`}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-2">{children}</div>
      {error && (
        <p role="alert" className="mt-3 text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
