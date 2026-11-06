import clsx from 'clsx';
import { useId, useState } from 'react';
import type { SnippetDialect, SnippetDraft } from '../../ipc/types';
import { BUILTIN_SNIPPETS } from '../snippets/builtins';
import { useSnippets } from '../snippets/snippetsStore';
import { snippetText } from '../snippets/text';

const EMPTY: SnippetDraft = { abbreviation: '', description: '', body: '', dialect: 'postgresql' };

/** One row of the list: a user snippet (with its id) or a built-in. */
interface Entry {
  key: string;
  id: string | null;
  builtin: boolean;
  draft: SnippetDraft;
  replaced?: boolean;
}

const input = 'w-full rounded border border-border bg-bg px-2 py-1';

/**
 * Settings > Snippets: the user's snippets (saved as they are changed, separately from the
 * other settings) and the built-in ones, which a user snippet with the same abbreviation replaces.
 */
export function SnippetsPanel() {
  const user = useSnippets((s) => s.user);
  const save = useSnippets((s) => s.save);
  const remove = useSnippets((s) => s.remove);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<{ id: string | null; draft: SnippetDraft } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ids = useId();

  const mine = new Set(user.map((s) => s.abbreviation.toLowerCase()));
  const entries: Entry[] = [
    ...user.map((s) => ({
      key: s.id,
      id: s.id,
      builtin: false,
      draft: {
        abbreviation: s.abbreviation,
        description: s.description,
        body: s.body,
        dialect: s.dialect,
      },
    })),
    ...BUILTIN_SNIPPETS.map((s) => ({
      key: `builtin:${s.abbreviation}`,
      id: null,
      builtin: true,
      draft: s,
      replaced: mine.has(s.abbreviation.toLowerCase()),
    })),
  ];
  const current = entries.find((e) => e.key === selected);

  function pick(entry: Entry) {
    setSelected(entry.key);
    setError(null);
    setNotice(null);
    setForm(entry.builtin ? null : { id: entry.id, draft: entry.draft });
  }

  async function submit() {
    if (!form) {
      return;
    }
    setError(null);
    try {
      const saved = await save(form.id, form.draft);
      setSelected(saved.id);
      setForm({ id: saved.id, draft: form.draft });
      setNotice('Saved. It expands in consoles right away.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function transfer(kind: 'import' | 'export') {
    setError(null);
    setNotice(null);
    try {
      if (kind === 'export') {
        const path = await useSnippets.getState().exportFile();
        if (path) {
          setNotice(`Exported ${user.length} snippets to ${path}.`);
        }
      } else {
        const result = await useSnippets.getState().importFile();
        if (result) {
          setNotice(`Imported: ${result.added} added, ${result.replaced} replaced.`);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const patch = (p: Partial<SnippetDraft>) =>
    setForm((f) => (f ? { ...f, draft: { ...f.draft, ...p } } : f));
  const preview = form ? snippetText(form.draft.body).text : null;

  return (
    <div className="grid h-[440px] grid-cols-[220px_1fr] gap-3">
      <div className="flex min-h-0 flex-col gap-2">
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 hover:bg-hover"
            onClick={() => {
              setSelected(null);
              setForm({ id: null, draft: EMPTY });
            }}
          >
            New
          </button>
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 hover:bg-hover"
            onClick={() => void transfer('import')}
          >
            Import…
          </button>
          <button
            type="button"
            className="rounded border border-border px-2 py-0.5 hover:bg-hover"
            onClick={() => void transfer('export')}
          >
            Export…
          </button>
        </div>
        <ul
          aria-label="Snippets"
          className="min-h-0 flex-1 overflow-auto rounded border border-border bg-bg py-1"
        >
          {entries.map((e) => (
            <li key={e.key}>
              <button
                type="button"
                aria-pressed={e.key === selected}
                aria-label={`${e.draft.abbreviation}, ${
                  e.builtin ? (e.replaced ? 'built-in, replaced' : 'built-in') : e.draft.description
                }`}
                onClick={() => pick(e)}
                className={clsx(
                  'flex w-full items-baseline gap-2 px-2 py-0.5 text-left',
                  e.key === selected ? 'bg-selected' : 'hover:bg-hover',
                  e.replaced && 'opacity-60',
                )}
              >
                <span className="font-mono">{e.draft.abbreviation}</span>
                <span className="min-w-0 truncate text-[11px] text-muted">
                  {e.builtin
                    ? e.replaced
                      ? 'built-in, replaced'
                      : 'built-in'
                    : e.draft.description}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="min-h-0 overflow-auto">
        {current?.builtin && (
          <div className="space-y-2">
            <p>
              <span className="font-mono">{current.draft.abbreviation}</span>:{' '}
              {current.draft.description}
            </p>
            <pre className="max-h-48 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[12px]">
              {snippetText(current.draft.body).text}
            </pre>
            <button
              type="button"
              className="rounded border border-border px-2 py-0.5 hover:bg-hover"
              onClick={() => setForm({ id: null, draft: current.draft })}
            >
              Customize (creates your own copy)
            </button>
          </div>
        )}
        {form && (
          <form
            className="mt-2 grid grid-cols-[110px_1fr] items-start gap-x-3 gap-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label htmlFor={`${ids}-abbr`} className="pt-1">
              Abbreviation
            </label>
            <input
              id={`${ids}-abbr`}
              className={`${input} font-mono`}
              value={form.draft.abbreviation}
              onChange={(e) => patch({ abbreviation: e.target.value })}
            />
            <label htmlFor={`${ids}-desc`} className="pt-1">
              Description
            </label>
            <input
              id={`${ids}-desc`}
              className={input}
              value={form.draft.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
            <label htmlFor={`${ids}-dialect`} className="pt-1">
              For
            </label>
            <select
              id={`${ids}-dialect`}
              className={input}
              value={form.draft.dialect}
              onChange={(e) => patch({ dialect: e.target.value as SnippetDialect })}
            >
              <option value="postgresql">PostgreSQL data sources</option>
              <option value="any">Every data source</option>
            </select>
            <label htmlFor={`${ids}-body`} className="pt-1">
              Template
            </label>
            <div>
              <textarea
                id={`${ids}-body`}
                rows={7}
                spellCheck={false}
                aria-describedby={`${ids}-help`}
                className={`${input} font-mono text-[12px]`}
                value={form.draft.body}
                onChange={(e) => patch({ body: e.target.value })}
              />
              <p id={`${ids}-help`} className="mt-0.5 text-[12px] text-muted">
                Tab stops: <code>$1</code>, <code>{'${1:name}'}</code>; <code>$0</code> is where the
                caret ends. Write <code>\$</code> for a literal <code>$</code> (dollar quotes,
                <code> $1</code> parameters).
              </p>
            </div>
            {preview !== null && preview !== '' && (
              <>
                <span className="pt-1 text-muted">Expands to</span>
                <pre
                  aria-label="Expanded text"
                  className="max-h-32 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[12px]"
                >
                  {preview}
                </pre>
              </>
            )}
            <span />
            <div className="flex gap-2">
              <button type="submit" className="rounded bg-accent px-3 py-1 text-accent-fg">
                Save Snippet
              </button>
              {form.id && (
                <button
                  type="button"
                  className="rounded border border-border px-3 py-1 text-danger hover:bg-hover"
                  onClick={() => {
                    const id = form.id;
                    if (id) {
                      void remove(id)
                        .then(() => {
                          setForm(null);
                          setSelected(null);
                        })
                        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
                    }
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </form>
        )}
        {!form && !current && (
          <p className="text-muted">
            Type an abbreviation in a console and press Tab to expand it. Choose a snippet to see
            it, or New to write your own.
          </p>
        )}
        {notice && (
          <p role="status" className="mt-2 text-muted">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-danger">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
