import { Eye, Lock, Plus, RotateCcw, Save } from 'lucide-react';
import { useState } from 'react';
import { askConfirm } from '../../app/dialogs';
import { Modal } from '../../components/ui/Modal';
import { backend } from '../../ipc/client';
import type { ConnectionProfile, EditStatement, EditTarget } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { addInsert, pendingCount, toChanges, type PendingEdits } from './editsModel';

interface Props {
  source: ConnectionProfile | undefined;
  target: EditTarget | null;
  /** Why the result cannot be edited, when `target` is null. */
  reason?: string;
  edits: PendingEdits;
  submitting: boolean;
  submitError?: string;
  submitted?: number;
  onChange(f: (e: PendingEdits) => PendingEdits): void;
  onRevert(): void;
  onSubmit(): Promise<void>;
}

/** Shows a value the way it will be bound: quoted text, or NULL. */
export function formatParam(v: string | null): string {
  return v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`;
}

export function EditBar({
  source,
  target,
  reason,
  edits,
  submitting,
  submitError,
  submitted,
  onChange,
  onRevert,
  onSubmit,
}: Props) {
  const [preview, setPreview] = useState<EditStatement[] | 'loading' | { error: string } | null>(
    null,
  );
  const count = pendingCount(edits);

  if (!target) {
    return (
      <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border bg-panel px-2 text-[12px] text-muted">
        <Lock size={12} aria-hidden /> <span className="truncate">Read-only: {reason}</span>
      </div>
    );
  }

  async function loadStatements(): Promise<EditStatement[]> {
    if (!source || !target) return [];
    return backend.resultPreviewEdits(source.id, target, toChanges(edits));
  }

  async function openPreview() {
    setPreview('loading');
    try {
      setPreview(await loadStatements());
    } catch (e) {
      setPreview({ error: toAppError(e).message });
    }
  }

  async function submit() {
    if (source?.environment === 'production') {
      // Production writes are confirmed with the exact statements.
      let statements: EditStatement[] = [];
      try {
        statements = await loadStatements();
      } catch {
        /* the submit below reports the error */
      }
      const ok = await askConfirm({
        title: `Modify production: ${source.name}?`,
        confirmLabel: 'Submit',
        danger: true,
        body: (
          <>
            <p>
              Apply {count} {count === 1 ? 'change' : 'changes'} to{' '}
              <strong>
                {target?.schema}.{target?.table}
              </strong>{' '}
              on the production data source <strong>{source.name}</strong>?
            </p>
            <StatementList statements={statements} />
          </>
        ),
      });
      if (!ok) return;
    }
    setPreview(null);
    await onSubmit();
  }

  return (
    <div
      role="toolbar"
      aria-label="Edit rows"
      className="flex h-7 shrink-0 items-center gap-1 border-b border-border bg-panel px-2 text-[12px]"
    >
      <span
        className="truncate font-mono text-muted"
        title="Rows are edited in this table, identified by its primary key"
      >
        {target.schema}.{target.table}
      </span>
      <button
        type="button"
        disabled={submitting}
        onClick={() => onChange((e) => addInsert(e, `new-${Date.now()}-${e.inserts.length}`))}
        title="Add a row (Insert). Edit a cell with double-click, F2 or Enter; Delete marks a row for deletion."
        className="flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-40"
      >
        <Plus size={12} aria-hidden /> Row
      </button>
      <span className="ml-auto text-muted" aria-live="polite">
        {submitError ? (
          <span role="alert" className="text-danger">
            {submitError}
          </span>
        ) : count > 0 ? (
          `${count} pending ${count === 1 ? 'change' : 'changes'}`
        ) : submitted ? (
          `Saved ${submitted} ${submitted === 1 ? 'change' : 'changes'}`
        ) : null}
      </span>
      <button
        type="button"
        disabled={count === 0 || submitting}
        onClick={() => void openPreview()}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-40"
      >
        <Eye size={12} aria-hidden /> Preview
      </button>
      <button
        type="button"
        disabled={count === 0 || submitting}
        onClick={onRevert}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-40"
      >
        <RotateCcw size={12} aria-hidden /> Revert
      </button>
      <button
        type="button"
        disabled={count === 0 || submitting}
        onClick={() => void submit()}
        className="flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-accent-fg disabled:opacity-40"
      >
        <Save size={12} aria-hidden /> {submitting ? 'Submitting…' : 'Submit'}
      </button>

      {preview && (
        <Modal
          title="Pending changes"
          width={720}
          onClose={() => setPreview(null)}
          footer={
            <>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="rounded border border-border px-3 py-1 hover:bg-hover"
              >
                Close
              </button>
              <button
                type="button"
                disabled={!Array.isArray(preview) || submitting}
                onClick={() => void submit()}
                className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50"
              >
                Submit
              </button>
            </>
          }
        >
          {preview === 'loading' ? (
            <p className="text-muted">Building statements…</p>
          ) : 'error' in preview ? (
            <p role="alert" className="text-danger">
              {preview.error}
            </p>
          ) : (
            <>
              <p className="mb-2 text-muted">
                These statements run in one transaction. Each update and delete must match exactly
                one row, or nothing is saved.
              </p>
              <StatementList statements={preview} />
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function StatementList({ statements }: { statements: EditStatement[] }) {
  return (
    <ol aria-label="Statements" className="max-h-80 space-y-2 overflow-auto">
      {statements.map((st, i) => (
        <li
          key={i}
          className="rounded border border-border bg-bg p-2 font-mono text-[12px] select-text"
        >
          <p className="break-words whitespace-pre-wrap">{st.sql}</p>
          {st.params.length > 0 && (
            <p className="mt-1 text-muted">
              {st.params.map((p, j) => (
                <span key={j} className="mr-3">
                  ${j + 1} = {formatParam(p)}
                </span>
              ))}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
