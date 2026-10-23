import { Plus, RotateCcw, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  ACTIONS,
  actionDef,
  CONTEXT_LABELS,
  type ActionDef,
  type ActionId,
} from '../../lib/actions';
import {
  chordLabel,
  chordOf,
  conflicts,
  defaultKeymap,
  effectiveKeymap,
  isModifierOnly,
  MAX_BINDINGS,
  unbindableReason,
  type Conflict,
} from '../../lib/keymap';

export type KeymapOverrides = Record<string, string[] | undefined>;

/** Same-context clashes: one of the two actions could never run, so Save waits for a fix. */
export function hasBlockingConflicts(overrides: KeymapOverrides): boolean {
  for (const list of conflicts(effectiveKeymap(overrides)).values()) {
    if (list.some((c) => c.kind === 'same')) {
      return true;
    }
  }
  return false;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function conflictText(conflict: Conflict): string {
  const other = actionDef(conflict.other);
  const chord = chordLabel(conflict.chord);
  if (conflict.kind === 'same') {
    return `${chord} is also bound to "${other.title}"; only one of them can run.`;
  }
  return other.context === 'global'
    ? `${chord} also runs "${other.title}" everywhere else.`
    : `${chord} runs "${other.title}" instead while the ${CONTEXT_LABELS[other.context].toLowerCase()} has focus.`;
}

/**
 * Settings > Keymap (REQ-KEY-02): every registered action with its shortcuts. Add records the next
 * key press; conflicts show inline as soon as a binding changes, before anything is saved.
 */
export function KeymapPanel({
  overrides,
  onChange,
}: {
  overrides: KeymapOverrides;
  onChange(overrides: KeymapOverrides): void;
}) {
  const [query, setQuery] = useState('');
  const [capturing, setCapturing] = useState<ActionId | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const defaults = useMemo(() => defaultKeymap(), []);
  const keymap = useMemo(() => effectiveKeymap(overrides), [overrides]);
  const found = useMemo(() => conflicts(keymap), [keymap]);

  const needle = query.trim().toLowerCase();
  const shown = ACTIONS.filter(
    (a) =>
      !needle ||
      a.title.toLowerCase().includes(needle) ||
      a.id.toLowerCase().includes(needle) ||
      CONTEXT_LABELS[a.context].toLowerCase().includes(needle) ||
      keymap[a.id].some((c) => chordLabel(c).toLowerCase().includes(needle)),
  );

  function setBindings(id: ActionId, chords: string[]) {
    // Bindings equal to the defaults are not stored, so later default changes still apply.
    const next = Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== id));
    onChange(same(chords, defaults[id]) ? next : { ...next, [id]: chords });
  }

  function onCaptureKey(e: React.KeyboardEvent, action: ActionDef & { id: ActionId }) {
    // Every key belongs to the recorder, including Escape and Tab (the dialog must not act on them).
    e.preventDefault();
    e.stopPropagation();
    if (isModifierOnly(e)) {
      return;
    }
    const chord = chordOf(e);
    if (chord === 'Escape') {
      setCapturing(null);
      setCaptureError(null);
      return;
    }
    const reason = unbindableReason(chord, action.context);
    if (reason) {
      setCaptureError(reason);
      return;
    }
    const current = keymap[action.id];
    if (!current.includes(chord)) {
      setBindings(action.id, [...current, chord]);
    }
    setCapturing(null);
    setCaptureError(null);
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="search"
          aria-label="Search actions"
          placeholder="Search actions or shortcuts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 rounded border border-border bg-bg px-2 py-1"
        />
        <button
          type="button"
          disabled={Object.keys(overrides).length === 0}
          onClick={() => onChange({})}
          className="flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-hover disabled:opacity-50"
        >
          <RotateCcw size={13} aria-hidden /> Reset all
        </button>
      </div>
      <table className="mt-2 w-full border-collapse text-left" aria-label="Shortcuts">
        <thead className="text-muted">
          <tr>
            <th className="py-1 pr-2 font-normal">Action</th>
            <th className="py-1 pr-2 font-normal">Where</th>
            <th className="py-1 font-normal">Shortcuts</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((action) => {
            const chords = keymap[action.id];
            const actionConflicts = found.get(action.id) ?? [];
            const changed = !same(chords, defaults[action.id]);
            return (
              <tr key={action.id} className="border-t border-border align-top">
                <th scope="row" className="py-1 pr-2 font-normal">
                  {action.title}
                  {actionConflicts.map((c) => (
                    <p
                      key={`${c.chord}-${c.other}`}
                      className={c.kind === 'same' ? 'text-danger' : 'text-muted'}
                    >
                      {conflictText(c)}
                    </p>
                  ))}
                </th>
                <td className="py-1 pr-2 text-muted">{CONTEXT_LABELS[action.context]}</td>
                <td className="py-1">
                  <div className="flex flex-wrap items-center gap-1">
                    {chords.map((chord) => (
                      <span
                        key={chord}
                        className="flex items-center gap-0.5 rounded border border-border bg-panel-2 pl-1.5 font-mono"
                      >
                        {chordLabel(chord)}
                        <button
                          type="button"
                          aria-label={`Remove ${chordLabel(chord)} from ${action.title}`}
                          onClick={() =>
                            setBindings(
                              action.id,
                              chords.filter((c) => c !== chord),
                            )
                          }
                          className="rounded px-0.5 hover:bg-hover"
                        >
                          <X size={12} aria-hidden />
                        </button>
                      </span>
                    ))}
                    {(chords.length < MAX_BINDINGS || capturing === action.id) && (
                      // One element for Add and the recorder, focused on click: WebKit does not
                      // focus buttons on click, and a newly mounted recorder could lose focus.
                      <button
                        type="button"
                        data-keymap-capture={capturing === action.id ? '' : undefined}
                        aria-label={
                          capturing === action.id
                            ? `Press the new shortcut for ${action.title}, Escape to cancel`
                            : `Add shortcut to ${action.title}`
                        }
                        onClick={(e) => {
                          e.currentTarget.focus();
                          setCapturing(action.id);
                          setCaptureError(null);
                        }}
                        onKeyDown={(e) => {
                          if (capturing === action.id) {
                            onCaptureKey(e, action);
                          }
                        }}
                        onBlur={() => {
                          if (capturing === action.id) {
                            setCapturing(null);
                            setCaptureError(null);
                          }
                        }}
                        className={
                          capturing === action.id
                            ? 'rounded border border-accent px-1.5 text-accent'
                            : 'flex items-center rounded px-1 text-muted hover:bg-hover'
                        }
                      >
                        {capturing === action.id ? 'Press keys…' : <Plus size={13} aria-hidden />}
                      </button>
                    )}
                    {changed && (
                      <button
                        type="button"
                        aria-label={`Reset ${action.title}`}
                        title="Reset to default"
                        onClick={() => setBindings(action.id, defaults[action.id])}
                        className="rounded px-1 text-muted hover:bg-hover"
                      >
                        <RotateCcw size={12} aria-hidden />
                      </button>
                    )}
                  </div>
                  {capturing === action.id && captureError && (
                    <p role="alert" className="text-danger">
                      {captureError}
                    </p>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shown.length === 0 && <p className="mt-2 text-muted">No action matches.</p>}
    </div>
  );
}
