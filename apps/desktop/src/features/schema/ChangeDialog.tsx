import { useEffect, useState, type ReactNode } from 'react';
import { askConfirm } from '../../app/dialogs';
import { Modal } from '../../components/ui/Modal';
import { backend } from '../../ipc/client';
import type { ConnectionProfile, SchemaChange } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { classify } from '../../lib/sql/classify';
import { splitStatements } from '../../lib/sql/statements';
import { effectiveColor } from '../connections/model';

/** Statements as one script, each ending with a semicolon. */
export function asScript(statements: string[]): string {
  return statements.map((s) => `${s};`).join('\n\n');
}

function scriptStatements(text: string): string[] {
  return splitStatements(text)
    .map((s) => text.slice(s.start, s.end).trim())
    .filter(Boolean);
}

interface Props {
  title: string;
  source: ConnectionProfile;
  /** What the form describes; `null` while it is incomplete. */
  change: SchemaChange | null;
  /** Label of the apply button, e.g. "Create" or "Drop". */
  applyLabel: string;
  danger?: boolean;
  /** When set, applying requires typing this name (CASCADE, several objects). */
  confirmName?: string;
  width?: number;
  children: ReactNode;
  /** Called after the change was applied (the dialog then closes). */
  onApplied(): void;
  onClose(): void;
}

/**
 * Frame for every schema tool (M4.5): the form, a live preview of the exact statements, an
 * optional hand edit of them, and Apply with the same guards as the console. Nothing runs before
 * the user has seen the statements.
 */
export function ChangeDialog({
  title,
  source,
  change,
  applyLabel,
  danger,
  confirmName,
  width = 760,
  children,
  onApplied,
  onClose,
}: Props) {
  const changeKey = JSON.stringify(change);
  const [preview, setPreview] = useState<{ key: string; statements?: string[]; error?: string }>();
  const [manual, setManual] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Regenerate the preview as the form changes (stops once the SQL was edited by hand).
  useEffect(() => {
    if (!change || manual !== null) {
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      backend
        .schemaPreview(change)
        .then((statements) => !cancelled && setPreview({ key: changeKey, statements }))
        .catch(
          (e: unknown) =>
            !cancelled && setPreview({ key: changeKey, error: toAppError(e).message }),
        );
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // `changeKey` stands for `change`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changeKey, manual]);

  const current = preview?.key === changeKey ? preview : undefined;
  const statements = manual !== null ? scriptStatements(manual) : (current?.statements ?? []);
  const nameOk = !confirmName || typed === confirmName;
  const canApply =
    !source.readOnly && !busy && statements.length > 0 && nameOk && (manual !== null || !!change);

  async function apply() {
    setError(null);
    // Hand-edited SQL is checked like console SQL: destructive statements are named.
    const destructive = statements
      .map((s) => ({ s, c: classify(s) }))
      .filter((x) => x.c.destructive);
    if (source.environment === 'production' || (manual !== null && destructive.length > 0)) {
      const ok = await askConfirm({
        title:
          source.environment === 'production'
            ? `Change production: ${source.name}?`
            : 'Run destructive statements?',
        confirmLabel: applyLabel,
        danger: true,
        body: (
          <>
            {source.environment === 'production' && (
              <p>
                <span
                  className="mr-1.5 inline-block h-2 w-2 rounded-full"
                  style={{ background: effectiveColor(source) ?? undefined }}
                />
                <strong>{source.name}</strong> is a <strong>production</strong> data source.
              </p>
            )}
            <pre className="max-h-48 overflow-auto rounded bg-panel-2 p-2 font-mono text-[12px] whitespace-pre-wrap">
              {asScript(statements)}
            </pre>
          </>
        ),
      });
      if (!ok) {
        return;
      }
    }
    setBusy(true);
    try {
      await backend.schemaApply(source.id, statements);
      onApplied();
      onClose();
    } catch (e) {
      const err = toAppError(e) as { message: string; hint?: string };
      setError([err.message, err.hint].filter(Boolean).join(' '));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={width}
      // Typed confirmation first; Cancel for other destructive changes; else the first field.
      initialFocus={confirmName ? '[data-autofocus]' : danger ? '[data-cancel]' : undefined}
      footer={
        <>
          <button
            type="button"
            data-cancel
            onClick={onClose}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={!canApply}
            className={`rounded px-3 py-1 disabled:opacity-50 ${danger ? 'bg-danger text-danger-fg' : 'bg-accent text-accent-fg'}`}
          >
            {busy ? 'Working…' : applyLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {children}
        <section aria-label="Statements">
          <div className="mb-1 flex items-center gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Statements
            </h3>
            {manual === null ? (
              <button
                type="button"
                className="text-accent underline"
                disabled={!current?.statements}
                onClick={() => setManual(asScript(current?.statements ?? []))}
              >
                Edit SQL
              </button>
            ) : (
              <>
                <span className="text-muted">Edited by hand: the form no longer updates it.</span>
                <button
                  type="button"
                  className="text-accent underline"
                  onClick={() => setManual(null)}
                >
                  Reset to generated
                </button>
              </>
            )}
          </div>
          {manual !== null ? (
            <textarea
              aria-label="Statements to run"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              spellCheck={false}
              className="h-40 w-full resize-y rounded border border-border bg-bg p-2 font-mono text-[12px]"
            />
          ) : current?.error ? (
            <p role="alert" className="text-danger">
              {current.error}
            </p>
          ) : (
            <pre
              aria-label="Statements to run"
              className="max-h-48 min-h-12 overflow-auto rounded bg-panel-2 p-2 font-mono text-[12px] whitespace-pre-wrap"
            >
              {change ? asScript(statements) : 'Complete the form to see the statements.'}
            </pre>
          )}
        </section>
        {confirmName && (
          <label className="flex flex-col gap-1">
            <span>
              Type <strong className="font-mono">{confirmName}</strong> to confirm.
            </span>
            <input
              data-autofocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="rounded border border-border bg-bg px-2 py-1 font-mono"
            />
          </label>
        )}
        {source.readOnly && (
          <p role="alert" className="text-danger">
            {source.name} is read-only: schema changes are blocked.
          </p>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
