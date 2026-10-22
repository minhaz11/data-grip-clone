import { useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import { useSettings } from '../../app/settingsStore';
import type { ResultTabs, Settings, ThemePreference } from '../../ipc/types';

export const FONT_SIZE_RANGE = { min: 9, max: 32 } as const;

export function SettingsDialog({ onClose }: { onClose(): void }) {
  const current = useSettings((s) => s.settings);
  const update = useSettings((s) => s.update);
  const error = useSettings((s) => s.error);
  const [draft, setDraft] = useState<Settings>(current);

  const fontSizeValid =
    Number.isInteger(draft.editorFontSize) &&
    draft.editorFontSize >= FONT_SIZE_RANGE.min &&
    draft.editorFontSize <= FONT_SIZE_RANGE.max;

  async function apply() {
    await update(draft);
    if (!useSettings.getState().error) onClose();
  }

  return (
    <Modal
      title="Settings"
      onClose={onClose}
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
            disabled={!fontSizeValid}
            className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50"
          >
            Save
          </button>
        </>
      }
    >
      <div className="grid grid-cols-[150px_1fr] items-center gap-x-3 gap-y-3">
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
      </div>
      {error && (
        <p role="alert" className="mt-3 text-danger">
          Could not save settings: {error}
        </p>
      )}
    </Modal>
  );
}
