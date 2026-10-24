import { useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import type { ExportFormat, ExportOptions, TableName } from '../../ipc/types';

export const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'tsv', label: 'TSV (tab-separated)' },
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
  { value: 'sql', label: 'SQL INSERT statements' },
  { value: 'markdown', label: 'Markdown table' },
];

export interface Scope {
  id: 'selection' | 'page' | 'all';
  label: string;
  disabled?: boolean;
}

export interface OutputChoice {
  scope: Scope['id'];
  format: ExportFormat;
  options: ExportOptions;
  target: 'file' | 'clipboard';
}

/** The last choices, so the dialog opens the way it was used (per app session). */
let remembered: Omit<OutputChoice, 'scope' | 'target'> & { target: OutputChoice['target'] } = {
  format: 'csv',
  options: { nullText: null, quoteAll: false, header: true },
  target: 'file',
};

interface Props {
  mode: 'copy' | 'export';
  /** Copy: what can be copied. Export always writes the entire result. */
  scopes?: Scope[];
  initialScope?: Scope['id'];
  /** SQL INSERT target, when the result has a single source table. */
  table?: TableName;
  rows: number;
  onSubmit(choice: OutputChoice): void;
  onClose(): void;
}

/** Format and options for copying (with a scope) or exporting (to a file or the clipboard). */
export function OutputDialog({
  mode,
  scopes = [],
  initialScope,
  table,
  rows,
  onSubmit,
  onClose,
}: Props) {
  const [scope, setScope] = useState<Scope['id']>(
    initialScope ?? scopes.find((s) => !s.disabled)?.id ?? 'all',
  );
  const [format, setFormat] = useState<ExportFormat>(
    mode === 'copy' && remembered.format === 'csv' ? 'tsv' : remembered.format,
  );
  const [nullText, setNullText] = useState(remembered.options.nullText ?? '');
  const [quoteAll, setQuoteAll] = useState(remembered.options.quoteAll);
  const [header, setHeader] = useState(remembered.options.header);
  const [target, setTarget] = useState<OutputChoice['target']>(remembered.target);

  const delimited = format === 'csv' || format === 'tsv';
  const nullDefault = format === 'markdown' ? 'NULL' : delimited ? '(empty)' : null;

  function submit() {
    const options: ExportOptions = {
      nullText: nullText === '' ? null : nullText,
      quoteAll,
      header,
      table: table ?? null,
    };
    remembered = { format, options, target };
    onSubmit({ scope, format, options, target: mode === 'copy' ? 'clipboard' : target });
  }

  return (
    <Modal
      title={mode === 'copy' ? 'Copy rows' : 'Export result'}
      onClose={onClose}
      width={520}
      initialFocus="[data-autofocus]"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded bg-accent px-3 py-1 text-accent-fg"
          >
            {mode === 'copy' ? 'Copy' : 'Export'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-3">
        {mode === 'copy' && (
          <>
            <span id="output-scope">Rows</span>
            <div role="radiogroup" aria-labelledby="output-scope" className="flex flex-col gap-1">
              {scopes.map((s) => (
                <label key={s.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="output-scope"
                    checked={scope === s.id}
                    disabled={s.disabled}
                    onChange={() => setScope(s.id)}
                  />
                  <span className={s.disabled ? 'text-muted' : undefined}>{s.label}</span>
                </label>
              ))}
            </div>
          </>
        )}
        <label htmlFor="output-format">Format</label>
        <select
          id="output-format"
          data-autofocus
          value={format}
          onChange={(e) => setFormat(e.target.value as ExportFormat)}
          className="rounded border border-border bg-bg px-2 py-1"
        >
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        {nullDefault !== null && (
          <>
            <label htmlFor="output-null">NULL as</label>
            <input
              id="output-null"
              value={nullText}
              placeholder={nullDefault}
              onChange={(e) => setNullText(e.target.value)}
              className="rounded border border-border bg-bg px-2 py-1 font-mono"
            />
          </>
        )}
        {(delimited || format === 'markdown') && (
          <>
            <span />
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={header}
                  onChange={(e) => setHeader(e.target.checked)}
                />
                Header row with column names
              </label>
              {delimited && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={quoteAll}
                    onChange={(e) => setQuoteAll(e.target.checked)}
                  />
                  Quote every value
                </label>
              )}
            </div>
          </>
        )}
        {format === 'sql' && (
          <p className="col-span-2 text-muted">
            {table ? (
              <>
                Statements insert into{' '}
                <strong className="font-mono">
                  {table.schema}.{table.name}
                </strong>
                .
              </>
            ) : (
              <>
                This result has no single source table: the statements use the placeholder name{' '}
                <strong className="font-mono">result_table</strong>.
              </>
            )}
          </p>
        )}
        {mode === 'export' && (
          <>
            <span id="output-target">To</span>
            <div role="radiogroup" aria-labelledby="output-target" className="flex gap-4">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="output-target"
                  checked={target === 'file'}
                  onChange={() => setTarget('file')}
                />
                File
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="output-target"
                  checked={target === 'clipboard'}
                  onChange={() => setTarget('clipboard')}
                />
                Clipboard
              </label>
            </div>
            <p className="col-span-2 text-muted">
              All {rows.toLocaleString()} {rows === 1 ? 'row' : 'rows'}, every column, as stored on
              the server (pending edits are not included).
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
