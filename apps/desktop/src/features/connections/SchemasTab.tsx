import { useState } from 'react';
import type { AppError, ConnectionDraft } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { ConnectionResult } from './ConnectionResult';
import { Field, input } from './fields';

/** `*` and `?` wildcards, as the backend applies them (case-sensitive, like schema names). */
export function globMatches(pattern: string, text: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${re}$`).test(text);
}

export function patternsOf(pattern: string): string[] {
  return pattern
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Which schemas the explorer and completion introspect: checked names plus wildcard patterns.
 * Nothing chosen means every schema.
 */
export function SchemasTab({
  draft,
  patch,
  load,
}: {
  draft: ConnectionDraft;
  patch(p: Partial<ConnectionDraft>): void;
  /** Every schema of the database (connects if needed). */
  load(): Promise<string[]>;
}) {
  const [all, setAll] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [filter, setFilter] = useState('');

  const patterns = patternsOf(draft.schemaPattern);
  const byPattern = (name: string) => patterns.some((p) => globMatches(p, name));
  const chosen = new Set(draft.schemaNames);
  // Chosen names the server did not list (renamed or dropped) stay visible so they can be removed.
  const names = all ? [...new Set([...all, ...draft.schemaNames])].sort() : draft.schemaNames;
  const shown = names.filter((n) => n.toLowerCase().includes(filter.trim().toLowerCase()));
  const everything = draft.schemaNames.length === 0 && patterns.length === 0;
  const inScope = all ? all.filter((n) => chosen.has(n) || byPattern(n)).length : null;

  async function fetchSchemas() {
    setLoading(true);
    setError(null);
    try {
      setAll(await load());
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setLoading(false);
    }
  }

  function toggle(name: string, on: boolean) {
    const next = new Set(chosen);
    if (on) {
      next.add(name);
    } else {
      next.delete(name);
    }
    patch({ schemaNames: [...next].sort() });
  }

  return (
    <div className="grid grid-cols-[130px_1fr] items-start gap-x-3 gap-y-2.5">
      <span />
      <p className="text-muted" aria-live="polite">
        {everything
          ? 'All schemas are loaded. Choose some to keep the explorer and completion focused.'
          : inScope !== null && all
            ? `${inScope} of ${all.length} schemas are loaded.`
            : `${draft.schemaNames.length} schema${draft.schemaNames.length === 1 ? '' : 's'} chosen${patterns.length ? ', plus pattern matches' : ''}.`}
      </p>

      <Field label="Pattern">
        {(id) => (
          <div>
            <input
              id={id}
              className={input}
              value={draft.schemaPattern}
              spellCheck={false}
              placeholder="e.g. app_*, tenant_?"
              aria-describedby={`${id}-help`}
              onChange={(e) => patch({ schemaPattern: e.target.value })}
            />
            <p id={`${id}-help`} className="mt-0.5 text-[12px] text-muted">
              Comma-separated; * matches any text, ? one character. Matches are added to the schemas
              checked below.
            </p>
          </div>
        )}
      </Field>

      <span className="pt-1">Schemas</span>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void fetchSchemas()}
            disabled={loading}
            className="rounded border border-border px-2 py-0.5 hover:bg-hover disabled:opacity-50"
          >
            {loading ? 'Loading…' : all ? 'Reload Schemas' : 'Load Schemas'}
          </button>
          {draft.schemaNames.length > 0 && (
            <button
              type="button"
              onClick={() => patch({ schemaNames: [] })}
              className="text-[12px] text-muted underline"
            >
              Clear selection
            </button>
          )}
          {all && all.length > 0 && (
            <button
              type="button"
              onClick={() => patch({ schemaNames: [...all].sort() })}
              className="text-[12px] text-muted underline"
            >
              Select all
            </button>
          )}
        </div>
        {error && <ConnectionResult result={{ error }} />}
        {names.length > 8 && (
          <input
            type="search"
            aria-label="Filter schemas"
            placeholder="Filter schemas"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className={input}
          />
        )}
        {names.length > 0 ? (
          <ul
            aria-label="Schemas to load"
            className="max-h-48 overflow-auto rounded border border-border bg-bg px-2 py-1"
          >
            {shown.map((name) => {
              const matched = byPattern(name);
              const missing = all !== null && !all.includes(name);
              return (
                <li key={name}>
                  <label className="flex items-center gap-2 py-0.5">
                    <input
                      type="checkbox"
                      checked={chosen.has(name)}
                      onChange={(e) => toggle(name, e.target.checked)}
                    />
                    <span className="min-w-0 truncate">{name}</span>
                    {matched && <span className="text-[11px] text-muted">matches pattern</span>}
                    {missing && <span className="text-[11px] text-danger">not found</span>}
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-[12px] text-muted">
            Load the schemas to choose them (uses the settings on the other tabs).
          </p>
        )}
      </div>
    </div>
  );
}
