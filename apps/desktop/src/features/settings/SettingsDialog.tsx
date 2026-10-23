import { useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import { useSettings } from '../../app/settingsStore';
import type {
  OutsideStatement,
  ResultTabs,
  SelectionRun,
  Settings,
  ThemePreference,
} from '../../ipc/types';

export const FONT_SIZE_RANGE = { min: 9, max: 32 } as const;
/** Time limits in seconds (matches the backend's `Settings::MAX_SECONDS`). */
export const MAX_SECONDS = 86_400;

/** Query history retention (matches `Settings::HISTORY_LIMIT_RANGE` and `MAX_HISTORY_DAYS`). */
export const HISTORY_LIMIT_RANGE = { min: 100, max: 1_000_000 } as const;
export const MAX_HISTORY_DAYS = 3_650;

const validSeconds = (n: number) => Number.isInteger(n) && n >= 0 && n <= MAX_SECONDS;
const inRange = (n: number, min: number, max: number) =>
  Number.isInteger(n) && n >= min && n <= max;

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const current = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const error = useSettings((s) => s.error);
  const [draft, setDraft] = useState<Settings>(current);

  const fontSizeValid =
    Number.isInteger(draft.editorFontSize) &&
    draft.editorFontSize >= FONT_SIZE_RANGE.min &&
    draft.editorFontSize <= FONT_SIZE_RANGE.max;

  const timesValid = validSeconds(draft.statementTimeoutSecs) && validSeconds(draft.longQuerySecs);
  const historyValid =
    inRange(draft.historyLimit, HISTORY_LIMIT_RANGE.min, HISTORY_LIMIT_RANGE.max) &&
    inRange(draft.historyMaxAgeDays, 0, MAX_HISTORY_DAYS);

  async function apply() {
    await update(draft);
    if (!useSettings.getState().error) onClose();
  }

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      width={560}
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
            onClick={apply}
            disabled={!fontSizeValid || !timesValid || !historyValid}
            className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50"
          >
            Save
          </button>
        </>
      }
    >
      <div className="grid grid-cols-[190px_1fr] items-center gap-x-3 gap-y-3">
        <label htmlFor="settings-theme">Theme</label>
        <select
          id="settings-theme"
          value={draft.theme}
          onChange={(e) => setDraft({ ...draft, theme: e.target.value as ThemePreference })}
          className="rounded border border-border bg-bg px-2 py-1"
        >
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>

        <label htmlFor="settings-font-size">Editor font size</label>
        <div>
          <input
            id="settings-font-size"
            type="number"
            min={FONT_SIZE_RANGE.min}
            max={FONT_SIZE_RANGE.max}
            value={Number.isNaN(draft.editorFontSize) ? '' : draft.editorFontSize}
            aria-invalid={!fontSizeValid}
            aria-describedby="settings-font-size-hint"
            onChange={(e) => setDraft({ ...draft, editorFontSize: e.target.valueAsNumber })}
            className="w-20 rounded border border-border bg-bg px-2 py-1"
          />
          <span
            id="settings-font-size-hint"
            className={fontSizeValid ? 'ml-2 text-muted' : 'ml-2 text-danger'}
          >
            {FONT_SIZE_RANGE.min}–{FONT_SIZE_RANGE.max} px
          </span>
        </div>
        <label htmlFor="settings-result-tabs">Results of a new run</label>
        <select
          id="settings-result-tabs"
          value={draft.resultTabs}
          onChange={(e) => setDraft({ ...draft, resultTabs: e.target.value as ResultTabs })}
          className="rounded border border-border bg-bg px-2 py-1"
        >
          <option value="reuse">Replace the previous results (pinned ones stay)</option>
          <option value="new">Keep the previous results as tabs</option>
        </select>
        <label htmlFor="settings-outside">Caret between statements</label>
        <select
          id="settings-outside"
          value={draft.runOutsideStatement}
          onChange={(e) =>
            setDraft({ ...draft, runOutsideStatement: e.target.value as OutsideStatement })
          }
          className="rounded border border-border bg-bg px-2 py-1"
        >
          <option value="nearest">Run the statement before the caret</option>
          <option value="ask">Ask which statement to run</option>
        </select>
        <label htmlFor="settings-selection">Selection of several statements</label>
        <select
          id="settings-selection"
          value={draft.runSelection}
          onChange={(e) => setDraft({ ...draft, runSelection: e.target.value as SelectionRun })}
          className="rounded border border-border bg-bg px-2 py-1"
        >
          <option value="all">Run them all</option>
          <option value="ask">Ask: one of them or all</option>
        </select>
        <SecondsField
          id="settings-timeout"
          label="Statement timeout"
          hint="seconds, 0 = no limit"
          value={draft.statementTimeoutSecs}
          onChange={(statementTimeoutSecs) => setDraft({ ...draft, statementTimeoutSecs })}
        />
        <SecondsField
          id="settings-long-query"
          label="Long-query notice after"
          hint="seconds, 0 = never"
          value={draft.longQuerySecs}
          onChange={(longQuerySecs) => setDraft({ ...draft, longQuerySecs })}
        />
        <NumberField
          id="settings-history-limit"
          label="Query history per data source"
          hint={`entries, ${HISTORY_LIMIT_RANGE.min.toLocaleString()}-${HISTORY_LIMIT_RANGE.max.toLocaleString()}`}
          min={HISTORY_LIMIT_RANGE.min}
          max={HISTORY_LIMIT_RANGE.max}
          value={draft.historyLimit}
          onChange={(historyLimit) => setDraft({ ...draft, historyLimit })}
        />
        <NumberField
          id="settings-history-age"
          label="Remove history older than"
          hint="days, 0 = keep regardless of age"
          min={0}
          max={MAX_HISTORY_DAYS}
          value={draft.historyMaxAgeDays}
          onChange={(historyMaxAgeDays) => setDraft({ ...draft, historyMaxAgeDays })}
        />
      </div>
      {error && (
        <p role="alert" className="mt-3 text-danger">
          Could not save settings: {error}
        </p>
      )}
    </Modal>
  );
}

function SecondsField(props: {
  id: string;
  label: string;
  hint: string;
  value: number;
  onChange(value: number): void;
}) {
  return <NumberField {...props} min={0} max={MAX_SECONDS} />;
}

function NumberField({
  id,
  label,
  hint,
  min,
  max,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  value: number;
  onChange(value: number): void;
}) {
  const valid = inRange(value, min, max);
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div>
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          value={Number.isNaN(value) ? '' : value}
          aria-invalid={!valid}
          aria-describedby={`${id}-hint`}
          onChange={(e) => onChange(e.target.valueAsNumber)}
          className="w-24 rounded border border-border bg-bg px-2 py-1"
        />
        <span id={`${id}-hint`} className={valid ? 'ml-2 text-muted' : 'ml-2 text-danger'}>
          {hint}
        </span>
      </div>
    </>
  );
}
