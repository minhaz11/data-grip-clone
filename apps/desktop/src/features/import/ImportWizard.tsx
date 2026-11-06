import clsx from 'clsx';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { askConfirm } from '../../app/dialogs';
import { useWorkspace } from '../../app/workspaceStore';
import { Modal } from '../../components/ui/Modal';
import { backend } from '../../ipc/client';
import type {
  AppError,
  ColumnModel,
  ConnectionProfile,
  ErrorPolicy,
  FileKind,
  ImportFile,
  ImportFormat,
  ImportPreview,
  ImportProgress,
  ImportSummary,
} from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { useMetadata } from '../explorer/metadataStore';
import { useNotifications } from '../notifications/notifications';
import {
  buildPlan,
  formatBytes,
  initialMapping,
  mappingProblem,
  newTableModel,
  TYPE_SUGGESTIONS,
  type MappedColumn,
} from './model';

type Step = 'file' | 'target' | 'columns' | 'review' | 'run';

const STEPS: { id: Step; label: string }[] = [
  { id: 'file', label: 'File' },
  { id: 'target', label: 'Target' },
  { id: 'columns', label: 'Columns' },
  { id: 'review', label: 'Review' },
  { id: 'run', label: 'Import' },
];

const KINDS: { value: string; label: string; kind: FileKind; delimiter?: string }[] = [
  { value: 'csv', label: 'CSV (comma)', kind: 'delimited', delimiter: ',' },
  { value: 'tsv', label: 'TSV (tab)', kind: 'delimited', delimiter: '\t' },
  { value: 'semicolon', label: 'Semicolon separated', kind: 'delimited', delimiter: ';' },
  { value: 'pipe', label: 'Pipe separated', kind: 'delimited', delimiter: '|' },
  { value: 'jsonArray', label: 'JSON array of objects', kind: 'jsonArray' },
  { value: 'jsonLines', label: 'JSON lines (one object per line)', kind: 'jsonLines' },
];

const ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252', 'iso-8859-15', 'shift_jis'];

const POLICIES: { value: ErrorPolicy; label: string; help: string }[] = [
  {
    value: 'abort',
    label: 'Stop at the first bad row',
    help: 'Nothing is imported if any row does not fit.',
  },
  {
    value: 'skip',
    label: 'Skip bad rows and list them',
    help: 'Rows that fit are imported; the others are listed with their line numbers.',
  },
  {
    value: 'null',
    label: 'Insert NULL for bad values',
    help: 'Every row is imported; values that do not fit become NULL and are listed.',
  },
];

function kindOf(f: ImportFormat): string {
  if (f.kind !== 'delimited') {
    return f.kind;
  }
  return KINDS.find((k) => k.delimiter === f.delimiter)?.value ?? 'custom';
}

const input = 'rounded border border-border bg-bg px-2 py-1';

interface Props {
  source: ConnectionProfile;
  /** Where the import was started: a schema (new table) or a table (append). */
  schema: string;
  table?: string;
  file?: ImportFile;
  onClose(): void;
}

/**
 * Import a CSV, TSV or JSON file into a new or existing table: format, target, column mapping,
 * review (DDL and error policy), then a streamed run with progress and Cancel.
 */
export function ImportWizard({ source, schema, table, file: initialFile, onClose }: Props) {
  const [step, setStep] = useState<Step>('file');
  const [file, setFile] = useState<ImportFile | null>(initialFile ?? null);
  const [format, setFormat] = useState<ImportFormat | null>(
    initialFile ? initialFile.detected.format : null,
  );
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [mode, setMode] = useState<'new' | 'existing'>(table ? 'existing' : 'new');
  const [targetSchema, setTargetSchema] = useState(schema);
  const [existingTable, setExistingTable] = useState(table ?? '');
  const [newName, setNewName] = useState('');
  const [tables, setTables] = useState<string[]>([]);
  const [existingColumns, setExistingColumns] = useState<ColumnModel[] | null>(null);
  const [mapping, setMapping] = useState<MappedColumn[]>([]);
  const [setup, setSetup] = useState<string[]>([]);
  const [editedSql, setEditedSql] = useState<string | null>(null);
  const [policy, setPolicy] = useState<ErrorPolicy>('abort');
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  /** Rows per second so far. */
  const [rate, setRate] = useState(0);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [failure, setFailure] = useState<AppError | null>(null);
  const presets = useWorkspace((s) => s.importPresets);
  const ids = useId();
  const targetName = mode === 'new' ? newName.trim() : existingTable;
  const running = job !== null && !summary && !failure;

  // The preview follows the file and its format.
  useEffect(() => {
    if (!file || !format) {
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      backend
        .importPreview(file.id, format, 20)
        .then((p) => {
          if (live) {
            setPreview(p);
            setPreviewError(null);
          }
        })
        .catch((e) => {
          if (live) {
            setPreview(null);
            setPreviewError(toAppError(e).message);
          }
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [file, format]);

  // Tables of the target schema, for appending.
  useEffect(() => {
    let live = true;
    backend
      .metadataChildren(source.id, { level: 'objects', schema: targetSchema, types: ['table'] })
      .then((nodes) => live && setTables(nodes.map((n) => n.name)))
      .catch(() => live && setTables([]));
    return () => {
      live = false;
    };
  }, [source.id, targetSchema]);

  // The existing table's columns, for mapping and value checks.
  useEffect(() => {
    if (mode !== 'existing' || !existingTable) {
      return;
    }
    let live = true;
    backend
      .tableModel(source.id, targetSchema, existingTable)
      .then((m) => live && setExistingColumns(m?.columns ?? null))
      .catch(() => live && setExistingColumns(null));
    return () => {
      live = false;
    };
  }, [mode, source.id, targetSchema, existingTable]);

  const mappingKey = `${mode}|${preview?.columns.join('\u001f') ?? ''}|${existingColumns?.map((c) => c.name).join('\u001f') ?? ''}`;
  const [mappedFor, setMappedFor] = useState('');
  if (preview && mappingKey !== mappedFor) {
    // A new file layout or target resets the mapping (during render, so it never shows stale).
    setMappedFor(mappingKey);
    setMapping(initialMapping(preview, mode === 'existing' ? existingColumns : null));
  }

  const problem = useMemo(() => {
    if (!file || !format) {
      return { step: 'file' as Step, message: 'Choose a file to import.' };
    }
    if (!preview) {
      return { step: 'file' as Step, message: previewError ?? 'Reading the file…' };
    }
    if (!targetName) {
      return { step: 'target' as Step, message: 'Choose or name the target table.' };
    }
    if (mode === 'existing' && !existingColumns) {
      return { step: 'target' as Step, message: 'Reading the table…' };
    }
    const m = mappingProblem(mapping);
    return m ? { step: 'columns' as Step, message: m } : null;
  }, [file, format, preview, previewError, targetName, mode, existingColumns, mapping]);

  // The CREATE TABLE statements for a new table, built in Rust as the schema tools do.
  useEffect(() => {
    if (step !== 'review' || mode !== 'new' || !newName.trim()) {
      return;
    }
    let live = true;
    backend
      .schemaPreview({
        kind: 'createTable',
        table: newTableModel(targetSchema, newName.trim(), mapping),
      })
      .then((statements) => live && setSetup(statements))
      .catch((e) => live && setError(toAppError(e).message));
    return () => {
      live = false;
    };
  }, [step, mode, targetSchema, newName, mapping]);

  async function pick() {
    setError(null);
    try {
      const picked = await backend.importPick();
      if (picked) {
        setFile(picked);
        setFormat(picked.detected.format);
        setPreview(null);
      }
    } catch (e) {
      setError(toAppError(e).message);
    }
  }

  const patchFormat = (p: Partial<ImportFormat>) => setFormat((f) => (f ? { ...f, ...p } : f));
  const patchColumn = (i: number, p: Partial<MappedColumn>) =>
    setMapping((m) => m.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const moveColumn = (i: number, by: -1 | 1) =>
    setMapping((m) => {
      const next = [...m];
      const [c] = next.splice(i, 1);
      if (c) {
        next.splice(Math.max(0, Math.min(next.length, i + by)), 0, c);
      }
      return next;
    });

  async function run() {
    if (!file || !format || !preview || problem) {
      return;
    }
    if (source.environment === 'production') {
      const ok = await askConfirm({
        title: 'Import Into Production',
        confirmLabel: 'Import',
        danger: true,
        body: (
          <p>
            <strong>{source.name}</strong> is a <strong>production</strong> data source. Import
            about {preview.estimatedRows.toLocaleString()} rows into{' '}
            <strong className="font-mono">
              {targetSchema}.{targetName}
            </strong>
            {mode === 'new' ? ' (a new table)' : ''}?
          </p>
        ),
      });
      if (!ok) {
        return;
      }
    }
    const statements =
      mode === 'new'
        ? editedSql !== null
          ? editedSql
              .split(/;\s*\n/)
              .map((s) => s.trim().replace(/;$/, ''))
              .filter(Boolean)
          : setup
        : [];
    setStep('run');
    const started = Date.now();
    setRate(0);
    setProgress(null);
    setSummary(null);
    setFailure(null);
    try {
      const id = await backend.importRun(
        file.id,
        source.id,
        buildPlan({
          format,
          columns: preview.columns,
          mapping,
          schema: targetSchema,
          table: targetName,
          setup: statements,
          policy,
        }),
        (e) => {
          if (e.event === 'progress') {
            setProgress(e);
            setRate(Math.round(e.rows / Math.max(0.001, (Date.now() - started) / 1000)));
          } else if (e.event === 'done') {
            setSummary(e);
            if (!e.cancelled) {
              // The tree and completion should see the new table or rows.
              useMetadata.getState().refresh(`${source.id}\u001fs:${targetSchema}`);
              useNotifications
                .getState()
                .notify(
                  `Imported ${e.rows.toLocaleString()} rows into ${targetSchema}.${targetName}`,
                );
            }
          } else {
            setFailure(e.error);
          }
        },
      );
      setJob(id);
    } catch (e) {
      setFailure(toAppError(e));
    }
  }

  const index = STEPS.findIndex((s) => s.id === step);
  const go = (to: Step) => setStep(to);
  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytes / progress.totalBytes) * 100))
      : 0;

  const footer =
    step === 'run' ? (
      running ? (
        <button
          type="button"
          onClick={() => job && void backend.importCancel(job)}
          className="rounded border border-border px-3 py-1 text-danger hover:bg-hover"
        >
          Cancel Import
        </button>
      ) : (
        <>
          {summary && summary.rejectedCount > 0 && job && (
            <button
              type="button"
              className="mr-auto rounded border border-border px-3 py-1 hover:bg-hover"
              onClick={() => {
                void backend
                  .importErrorsSave(job)
                  .then(
                    (path) =>
                      path && useNotifications.getState().notify(`Import errors saved to ${path}`),
                  )
                  .catch((e) => setError(toAppError(e).message));
              }}
            >
              Save Error Log…
            </button>
          )}
          {failure && (
            <button
              type="button"
              className="mr-auto rounded border border-border px-3 py-1 hover:bg-hover"
              onClick={() => setStep('review')}
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-accent px-3 py-1 text-accent-fg"
          >
            Close
          </button>
        </>
      )
    ) : (
      <>
        <button
          type="button"
          onClick={onClose}
          className="mr-auto rounded border border-border px-3 py-1 hover:bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={index === 0}
          onClick={() => go(STEPS[index - 1]?.id ?? 'file')}
          className="rounded border border-border px-3 py-1 hover:bg-hover disabled:opacity-50"
        >
          Back
        </button>
        {step === 'review' ? (
          <button
            type="button"
            disabled={!!problem}
            onClick={() => void run()}
            className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50"
          >
            Import
          </button>
        ) : (
          <button
            type="button"
            onClick={() => go(STEPS[index + 1]?.id ?? 'review')}
            className="rounded bg-accent px-3 py-1 text-accent-fg"
          >
            Next
          </button>
        )}
      </>
    );

  return (
    <Modal
      title={`Import Data into ${source.name}`}
      onClose={running ? () => {} : onClose}
      width={820}
      footer={footer}
    >
      <ol aria-label="Import steps" className="mb-3 flex gap-1 text-[12px]">
        {STEPS.map((s, i) => (
          <li
            key={s.id}
            aria-current={s.id === step ? 'step' : undefined}
            className={clsx(
              'rounded px-2 py-0.5',
              s.id === step ? 'bg-accent text-accent-fg' : i < index ? 'text-fg' : 'text-muted',
            )}
          >
            {i + 1}. {s.label}
          </li>
        ))}
      </ol>

      {step === 'file' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void pick()}
              className="rounded border border-border px-3 py-1 hover:bg-hover"
            >
              {file ? 'Choose Another File…' : 'Choose File…'}
            </button>
            {file && (
              <span className="min-w-0 truncate">
                <span className="font-mono">{file.name}</span>{' '}
                <span className="text-muted">
                  ({formatBytes(file.size)}, detected {file.detected.encoding})
                </span>
              </span>
            )}
          </div>
          {format && (
            <>
              <div className="grid grid-cols-[120px_1fr_120px_1fr] items-center gap-x-3 gap-y-2">
                <label htmlFor={`${ids}-kind`}>Format</label>
                <select
                  id={`${ids}-kind`}
                  className={input}
                  value={kindOf(format)}
                  onChange={(e) => {
                    const k = KINDS.find((x) => x.value === e.target.value);
                    if (k) {
                      patchFormat({
                        kind: k.kind,
                        ...(k.delimiter ? { delimiter: k.delimiter } : {}),
                      });
                    }
                  }}
                >
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                  {kindOf(format) === 'custom' && <option value="custom">Custom delimiter</option>}
                </select>
                <label htmlFor={`${ids}-encoding`}>Encoding</label>
                <select
                  id={`${ids}-encoding`}
                  className={input}
                  value={format.encoding ?? ''}
                  onChange={(e) => patchFormat({ encoding: e.target.value || null })}
                >
                  <option value="">Detect ({file?.detected.encoding})</option>
                  {ENCODINGS.map((enc) => (
                    <option key={enc} value={enc}>
                      {enc}
                    </option>
                  ))}
                </select>
                {format.kind === 'delimited' && (
                  <>
                    <label htmlFor={`${ids}-delim`}>Delimiter</label>
                    <input
                      id={`${ids}-delim`}
                      className={`${input} w-16 font-mono`}
                      maxLength={2}
                      value={format.delimiter === '\t' ? '\\t' : format.delimiter}
                      onChange={(e) => {
                        const v = e.target.value === '\\t' ? '\t' : e.target.value.slice(-1);
                        if (v) {
                          patchFormat({ delimiter: v });
                        }
                      }}
                    />
                    <label htmlFor={`${ids}-quote`}>Quote</label>
                    <input
                      id={`${ids}-quote`}
                      className={`${input} w-16 font-mono`}
                      maxLength={1}
                      value={format.quote}
                      onChange={(e) => e.target.value && patchFormat({ quote: e.target.value })}
                    />
                    <label htmlFor={`${ids}-escape`}>Escape</label>
                    <input
                      id={`${ids}-escape`}
                      className={`${input} w-16 font-mono`}
                      maxLength={1}
                      placeholder="doubled"
                      value={format.escape ?? ''}
                      onChange={(e) => patchFormat({ escape: e.target.value || null })}
                    />
                    <label htmlFor={`${ids}-null`}>NULL text</label>
                    <input
                      id={`${ids}-null`}
                      className={`${input} w-28 font-mono`}
                      placeholder="none"
                      value={format.nullToken ?? ''}
                      onChange={(e) => patchFormat({ nullToken: e.target.value || null })}
                    />
                  </>
                )}
              </div>
              {format.kind === 'delimited' && (
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={format.header}
                      onChange={(e) => patchFormat({ header: e.target.checked })}
                    />
                    First row has column names
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={format.trim}
                      onChange={(e) => patchFormat({ trim: e.target.checked })}
                    />
                    Trim spaces
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={format.emptyIsNull}
                      onChange={(e) => patchFormat({ emptyIsNull: e.target.checked })}
                    />
                    Empty unquoted values are NULL
                  </label>
                </div>
              )}
              <Presets format={format} presets={presets} onLoad={(f) => setFormat({ ...f })} />
              {previewError && (
                <p role="alert" className="text-danger">
                  {previewError}
                </p>
              )}
              {preview && <PreviewTable preview={preview} />}
            </>
          )}
        </div>
      )}

      {step === 'target' && (
        <div className="grid grid-cols-[140px_1fr] items-center gap-x-3 gap-y-2.5">
          <span>Import into</span>
          <div className="flex gap-4">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`${ids}-mode`}
                checked={mode === 'new'}
                onChange={() => setMode('new')}
              />
              A new table
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name={`${ids}-mode`}
                checked={mode === 'existing'}
                onChange={() => setMode('existing')}
              />
              An existing table
            </label>
          </div>
          <label htmlFor={`${ids}-schema`}>Schema</label>
          <input
            id={`${ids}-schema`}
            className={input}
            value={targetSchema}
            onChange={(e) => setTargetSchema(e.target.value)}
          />
          {mode === 'new' ? (
            <>
              <label htmlFor={`${ids}-new`}>Table name</label>
              <input
                id={`${ids}-new`}
                className={input}
                value={newName}
                placeholder={file ? file.name.replace(/\.[^.]+$/, '') : ''}
                onChange={(e) => setNewName(e.target.value)}
              />
            </>
          ) : (
            <>
              <label htmlFor={`${ids}-existing`}>Table</label>
              <select
                id={`${ids}-existing`}
                className={input}
                value={existingTable}
                onChange={(e) => setExistingTable(e.target.value)}
              >
                <option value="">Choose a table</option>
                {[...new Set([...tables, ...(table ? [table] : [])])].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      )}

      {step === 'columns' && preview && (
        <table aria-label="Column mapping" className="w-full text-[12px]">
          <thead className="text-left text-muted">
            <tr>
              <th className="w-10 py-1">Use</th>
              <th>File column</th>
              <th>Sample</th>
              <th>Target column</th>
              <th>{mode === 'new' ? 'Type' : 'Target type'}</th>
              {mode === 'new' && <th className="w-16">Order</th>}
            </tr>
          </thead>
          <tbody>
            {mapping.map((m, i) => {
              const header = preview.columns[m.source] ?? '';
              const sample = preview.rows[0]?.[m.source];
              return (
                <tr key={m.source} className="border-t border-border">
                  <td className="py-1">
                    <input
                      type="checkbox"
                      aria-label={`Import ${header}`}
                      checked={m.include}
                      onChange={(e) => patchColumn(i, { include: e.target.checked })}
                    />
                  </td>
                  <td className="font-mono">{header}</td>
                  <td className="max-w-40 truncate font-mono text-muted" title={sample ?? 'NULL'}>
                    {sample ?? 'NULL'}
                  </td>
                  <td>
                    {mode === 'new' ? (
                      <input
                        aria-label={`Target column for ${header}`}
                        className={`${input} w-full py-0.5 font-mono`}
                        value={m.target}
                        disabled={!m.include}
                        onChange={(e) => patchColumn(i, { target: e.target.value })}
                      />
                    ) : (
                      <select
                        aria-label={`Target column for ${header}`}
                        className={`${input} w-full py-0.5`}
                        value={m.target}
                        disabled={!m.include}
                        onChange={(e) => {
                          const col = existingColumns?.find((c) => c.name === e.target.value);
                          patchColumn(i, { target: e.target.value, type: col?.typeName ?? 'text' });
                        }}
                      >
                        <option value="">Choose a column</option>
                        {existingColumns?.map((c) => (
                          <option key={c.name} value={c.name}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>
                    {mode === 'new' ? (
                      <>
                        <input
                          aria-label={`Type for ${header}`}
                          className={`${input} w-full py-0.5 font-mono`}
                          list={`${ids}-types`}
                          value={m.type}
                          disabled={!m.include}
                          onChange={(e) => patchColumn(i, { type: e.target.value })}
                        />
                        {preview.inferred[m.source] && (
                          <span className="sr-only">inferred {preview.inferred[m.source]}</span>
                        )}
                      </>
                    ) : (
                      <span className="font-mono text-muted">{m.include ? m.type : ''}</span>
                    )}
                  </td>
                  {mode === 'new' && (
                    <td>
                      <button
                        type="button"
                        aria-label={`Move ${header} up`}
                        disabled={i === 0}
                        onClick={() => moveColumn(i, -1)}
                        className="rounded p-0.5 hover:bg-hover disabled:opacity-30"
                      >
                        <ArrowUp size={12} aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${header} down`}
                        disabled={i === mapping.length - 1}
                        onClick={() => moveColumn(i, 1)}
                        className="rounded p-0.5 hover:bg-hover disabled:opacity-30"
                      >
                        <ArrowDown size={12} aria-hidden />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          <datalist id={`${ids}-types`}>
            {TYPE_SUGGESTIONS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </table>
      )}

      {step === 'review' && (
        <div className="space-y-3">
          <p>
            Import <span className="font-mono">{file?.name}</span> (about{' '}
            {(preview?.estimatedRows ?? 0).toLocaleString()} rows) into{' '}
            <strong className="font-mono">
              {targetSchema}.{targetName || '?'}
            </strong>
            {mode === 'new' ? ', a new table' : ''}. It runs in one transaction: a failure or Cancel
            leaves no rows{mode === 'new' ? ' and no table' : ''} behind.
          </p>
          {mode === 'new' && (
            <div>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-muted">Statements run first</span>
                <button
                  type="button"
                  className="text-[12px] text-accent underline"
                  onClick={() =>
                    setEditedSql(editedSql === null ? setup.map((s) => `${s};`).join('\n') : null)
                  }
                >
                  {editedSql === null ? 'Edit SQL' : 'Reset to generated'}
                </button>
              </div>
              {editedSql === null ? (
                <pre
                  aria-label="Generated statements"
                  className="max-h-40 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[12px]"
                >
                  {setup.map((s) => `${s};`).join('\n')}
                </pre>
              ) : (
                <textarea
                  aria-label="Statements to run"
                  className={`${input} h-40 w-full font-mono text-[12px]`}
                  spellCheck={false}
                  value={editedSql}
                  onChange={(e) => setEditedSql(e.target.value)}
                />
              )}
            </div>
          )}
          <fieldset>
            <legend className="mb-1">When a value does not fit its column</legend>
            {POLICIES.map((p) => (
              <label key={p.value} className="flex items-start gap-2 py-0.5">
                <input
                  type="radio"
                  name={`${ids}-policy`}
                  checked={policy === p.value}
                  onChange={() => setPolicy(p.value)}
                  className="mt-1"
                />
                <span>
                  {p.label}
                  <span className="block text-[12px] text-muted">{p.help}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {problem && (
            <p role="alert" className="text-danger">
              {problem.message}{' '}
              <button
                type="button"
                className="text-accent underline"
                onClick={() => setStep(problem.step)}
              >
                Fix
              </button>
            </p>
          )}
        </div>
      )}

      {step === 'run' && (
        <div className="space-y-3" aria-live="polite">
          {running && (
            <>
              <div
                role="progressbar"
                aria-label="Import progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-2 overflow-hidden rounded bg-panel-2"
              >
                <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
              </div>
              <p>
                {(progress?.rows ?? 0).toLocaleString()} rows · {rate.toLocaleString()} rows/s
                {progress && progress.rejected > 0 ? ` · ${progress.rejected} rejected` : ''}
              </p>
            </>
          )}
          {summary &&
            (summary.cancelled ? (
              <p>Import cancelled. Nothing was imported.</p>
            ) : (
              <>
                <p role="status">
                  Imported <strong>{summary.rows.toLocaleString()}</strong> rows in{' '}
                  {(summary.elapsedMs / 1000).toFixed(1)} s.
                  {summary.rejectedCount > 0 &&
                    ` ${summary.rejectedCount.toLocaleString()} rows had values that did not fit${
                      summary.nulled > 0
                        ? ` (${summary.nulled} values set to NULL)`
                        : ' and were skipped'
                    }.`}
                </p>
                {summary.rejected.length > 0 && (
                  <table aria-label="Rejected rows" className="w-full text-[12px]">
                    <thead className="text-left text-muted">
                      <tr>
                        <th>Line</th>
                        <th>Column</th>
                        <th>Problem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.rejected.slice(0, 100).map((r) => (
                        <tr key={`${r.line}:${r.column ?? ''}`} className="border-t border-border">
                          <td className="font-mono">{r.line}</td>
                          <td className="font-mono">{r.column ?? ''}</td>
                          <td>
                            {r.nulled ? 'NULL: ' : ''}
                            {r.message}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            ))}
          {failure && (
            <div role="alert" className="text-danger">
              <p className="font-medium">The import failed; nothing was imported.</p>
              <p>{failure.message}</p>
              {failure.hint && <p className="text-muted">{failure.hint}</p>}
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

function Presets({
  format,
  presets,
  onLoad,
}: {
  format: ImportFormat;
  presets: { name: string; format: ImportFormat }[];
  onLoad(f: ImportFormat): void;
}) {
  const [name, setName] = useState('');
  const id = useId();
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <label htmlFor={id}>Preset</label>
      <select
        id={id}
        className={`${input} py-0.5`}
        value=""
        onChange={(e) => {
          const p = presets.find((x) => x.name === e.target.value);
          if (p) {
            onLoad(p.format);
          }
        }}
      >
        <option value="">{presets.length ? 'Load a preset' : 'No presets yet'}</option>
        {presets.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
      <input
        aria-label="Preset name"
        className={`${input} w-40 py-0.5`}
        placeholder="Name to save as"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        type="button"
        disabled={!name.trim()}
        className="rounded border border-border px-2 py-0.5 hover:bg-hover disabled:opacity-50"
        onClick={() => {
          useWorkspace.getState().saveImportPreset(name.trim(), format);
          setName('');
        }}
      >
        Save Preset
      </button>
    </div>
  );
}

function PreviewTable({ preview }: { preview: ImportPreview }) {
  return (
    <div className="max-h-56 overflow-auto rounded border border-border">
      <table aria-label="File preview" className="w-full font-mono text-[12px]">
        <thead className="sticky top-0 bg-panel-2 text-left">
          <tr>
            <th className="px-1.5 py-0.5 text-muted">Line</th>
            {preview.columns.map((c, i) => (
              <th key={`${c}:${i}`} className="px-1.5 py-0.5">
                {c}
                <span className="block font-sans text-[10px] font-normal text-muted">
                  {preview.inferred[i]}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, r) => (
            <tr key={preview.lines[r] ?? r} className="border-t border-border">
              <td className="px-1.5 text-muted">{preview.lines[r]}</td>
              {preview.columns.map((c, i) => (
                <td key={`${c}:${i}`} className="max-w-48 truncate px-1.5">
                  {row[i] === null || row[i] === undefined ? (
                    <span className="text-muted">NULL</span>
                  ) : (
                    row[i]
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-1.5 py-1 font-sans text-[12px] text-muted">
        About {preview.estimatedRows.toLocaleString()} rows in the file.
      </p>
    </div>
  );
}
