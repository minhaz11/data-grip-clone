import { useId, useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import type { AiConsent, AiContextLevel, AiRowTable } from '../../ipc/types';

export const LEVEL_LABELS: Record<AiContextLevel, string> = {
  none: 'SQL text only',
  schema: 'SQL and schema',
  schemaAndRows: 'SQL, schema and sample rows',
};

const LEVEL_HELP: Record<AiContextLevel, string> = {
  none: 'Only the SQL you selected or the statement at the caret, and your question.',
  schema:
    'Also the names, types and keys of the tables and views the SQL uses (and the tables they reference). No data.',
  schemaAndRows:
    'Also up to 5 rows from up to 3 of those tables. You are asked before each request unless you always allow it.',
};

export interface ConsentChoice {
  level: AiContextLevel;
  remember: boolean;
  rowsAlways: boolean;
}

/**
 * How much of a data source may be sent to the AI. Production sources start at "SQL text only";
 * a choice that is not remembered lasts until the app restarts.
 */
export function ConsentDialog({
  sourceName,
  production,
  consent,
  onSubmit,
  onCancel,
}: {
  sourceName: string;
  production: boolean;
  consent: AiConsent;
  onSubmit(choice: ConsentChoice): void;
  onCancel(): void;
}) {
  const ids = useId();
  const [level, setLevel] = useState<AiContextLevel>(
    consent.decided ? consent.level : consent.suggested,
  );
  const [remember, setRemember] = useState(consent.remembered);
  const [rowsAlways, setRowsAlways] = useState(consent.rowsAlways);
  const canAlways = level === 'schemaAndRows' && remember;

  return (
    <Modal
      title={`AI context for ${sourceName}`}
      onClose={onCancel}
      width={520}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit({ level, remember, rowsAlways: canAlways && rowsAlways })}
            className="rounded bg-accent px-3 py-1 text-accent-fg"
          >
            Continue
          </button>
        </>
      }
    >
      <fieldset className="space-y-2">
        <legend className="mb-2">What may be sent to Anthropic from this data source?</legend>
        {production && (
          <p className="rounded border border-border bg-bg p-2 text-[12px]">
            This is a production data source. Consider sending the SQL text only.
          </p>
        )}
        {(Object.keys(LEVEL_LABELS) as AiContextLevel[]).map((value) => (
          <label key={value} className="flex items-start gap-2">
            <input
              type="radio"
              name={`${ids}-level`}
              value={value}
              checked={level === value}
              onChange={() => setLevel(value)}
              aria-describedby={`${ids}-${value}`}
              className="mt-1"
            />
            <span>
              {LEVEL_LABELS[value]}
              <span id={`${ids}-${value}`} className="block text-[12px] text-muted">
                {LEVEL_HELP[value]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mt-3 space-y-1">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          Remember for this data source (otherwise until Quarry restarts)
        </label>
        <label className={`flex items-center gap-2 ${canAlways ? '' : 'opacity-50'}`}>
          <input
            type="checkbox"
            checked={canAlways && rowsAlways}
            disabled={!canAlways}
            onChange={(e) => setRowsAlways(e.target.checked)}
          />
          Always allow sample rows without asking
        </label>
        <p className="text-[12px] text-muted">You can revoke this later in Settings &gt; AI.</p>
      </div>
    </Modal>
  );
}

/** Asks before sample rows are sent: which tables, which columns, how many rows. */
export function RowConsentDialog({
  tables,
  onAnswer,
  onCancel,
}: {
  tables: AiRowTable[];
  onAnswer(include: boolean): void;
  onCancel(): void;
}) {
  return (
    <Modal
      title="Send sample rows?"
      onClose={onCancel}
      width={520}
      footer={
        <>
          <button
            type="button"
            onClick={() => onAnswer(false)}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Without Rows
          </button>
          <button
            type="button"
            onClick={() => onAnswer(true)}
            className="rounded bg-accent px-3 py-1 text-accent-fg"
          >
            Include Rows
          </button>
        </>
      }
    >
      <p>These rows would be read now and sent with the request:</p>
      <ul aria-label="Sample rows" className="mt-2 space-y-1">
        {tables.map((t) => (
          <li key={t.table}>
            Up to {t.rows} rows from <span className="font-mono">{t.table}</span>
            <span className="block text-[12px] text-muted">
              Columns: <span className="font-mono">{t.columns.join(', ')}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-muted">
        Columns on the ignore list are never read. You will see the exact rows before sending.
      </p>
    </Modal>
  );
}
