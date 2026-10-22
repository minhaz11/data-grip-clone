import { useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import type { Cell } from '../../ipc/types';

/**
 * Values for statement parameters (REQ-EDIT-10), prefilled with the console's last values. Each
 * value is sent as a bound parameter; "NULL" sends SQL NULL.
 */
export function ParamsDialog({
  names,
  initial,
  onDone,
}: {
  names: string[];
  initial: Record<string, Cell>;
  onDone(values: Record<string, Cell> | null): void;
}) {
  const [values, setValues] = useState<Record<string, Cell>>(() =>
    Object.fromEntries(names.map((n) => [n, n in initial ? (initial[n] ?? null) : ''])),
  );
  const label = (name: string) => (/^\d+$/.test(name) ? `$${name}` : `:${name}`);
  return (
    <Modal
      title="Statement parameters"
      onClose={() => onDone(null)}
      width={480}
      footer={
        <>
          <button
            type="button"
            onClick={() => onDone(null)}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="params-form"
            className="rounded bg-accent px-3 py-1 text-accent-fg"
          >
            Run
          </button>
        </>
      }
    >
      <form
        id="params-form"
        onSubmit={(e) => {
          e.preventDefault();
          onDone(values);
        }}
        className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2"
      >
        <p className="col-span-3 text-muted">
          Values are bound to the statement, not pasted into it; the server converts them to the
          parameter's type.
        </p>
        {names.map((name) => {
          const isNull = values[name] === null;
          return (
            <div key={name} className="contents">
              <label htmlFor={`param-${name}`} className="font-mono">
                {label(name)}
              </label>
              <input
                id={`param-${name}`}
                value={values[name] ?? ''}
                disabled={isNull}
                placeholder={isNull ? 'NULL' : undefined}
                onChange={(e) => setValues({ ...values, [name]: e.target.value })}
                className="rounded border border-border bg-bg px-2 py-1 font-mono disabled:opacity-60"
              />
              <label className="flex items-center gap-1 text-muted">
                <input
                  type="checkbox"
                  aria-label={`${label(name)} is NULL`}
                  checked={isNull}
                  onChange={(e) => setValues({ ...values, [name]: e.target.checked ? null : '' })}
                />
                NULL
              </label>
            </div>
          );
        })}
      </form>
    </Modal>
  );
}

export interface ChoosableStatement {
  sql: string;
  offset: number;
}

/**
 * Which statements to run when the caret is outside every statement or a selection holds
 * several (REQ-EDIT-04 chooser). Resolves to the chosen statements.
 */
export function StatementChooser({
  title,
  statements,
  allowAll,
  onDone,
}: {
  title: string;
  statements: ChoosableStatement[];
  allowAll: boolean;
  onDone(chosen: ChoosableStatement[] | null): void;
}) {
  const firstLine = (sql: string) => {
    const line = sql.split('\n').find((l) => l.trim() && !l.trim().startsWith('--')) ?? sql;
    return line.length > 90 ? `${line.slice(0, 90)}…` : line;
  };
  return (
    <Modal
      title={title}
      onClose={() => onDone(null)}
      width={620}
      footer={
        <button
          type="button"
          onClick={() => onDone(null)}
          className="rounded border border-border px-3 py-1 hover:bg-hover"
        >
          Cancel
        </button>
      }
    >
      <ul aria-label="Statements" className="max-h-80 space-y-1 overflow-auto">
        {allowAll && (
          <li>
            <button
              type="button"
              onClick={() => onDone(statements)}
              className="w-full rounded px-2 py-1 text-left font-semibold hover:bg-hover"
            >
              All {statements.length} statements
            </button>
          </li>
        )}
        {statements.map((st) => (
          <li key={st.offset}>
            <button
              type="button"
              onClick={() => onDone([st])}
              title={st.sql}
              className="w-full truncate rounded px-2 py-1 text-left font-mono text-[12px] hover:bg-hover"
            >
              {firstLine(st.sql)}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
