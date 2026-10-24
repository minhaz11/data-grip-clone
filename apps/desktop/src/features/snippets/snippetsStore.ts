import { create } from 'zustand';
import { errorMessage } from '../../app/settingsStore';
import { backend } from '../../ipc/client';
import type { Snippet, SnippetDraft, SnippetImport } from '../../ipc/types';
import { BUILTIN_SNIPPETS } from './builtins';

interface SnippetsState {
  /** User snippets from app.db. */
  user: Snippet[];
  load(): Promise<void>;
  /** Mutations reject with a user-facing `Error`. */
  save(snippetId: string | null, draft: SnippetDraft): Promise<Snippet>;
  remove(snippetId: string): Promise<void>;
  importFile(): Promise<SnippetImport | null>;
  exportFile(): Promise<string | null>;
}

function rethrow(e: unknown): never {
  throw new Error(errorMessage(e));
}

export const useSnippets = create<SnippetsState>((set) => {
  async function reload() {
    set({ user: await backend.snippetsList() });
  }
  return {
    user: [],
    async load() {
      try {
        await reload();
      } catch {
        // Built-in snippets still work.
      }
    },
    async save(snippetId, draft) {
      const saved = await backend.snippetSave(snippetId, draft).catch(rethrow);
      await reload();
      return saved;
    },
    async remove(snippetId) {
      await backend.snippetDelete(snippetId).catch(rethrow);
      await reload();
    },
    async importFile() {
      const result = await backend.snippetsImport().catch(rethrow);
      await reload();
      return result;
    },
    exportFile: () => backend.snippetsExport().catch(rethrow),
  };
});

const key = (s: Pick<SnippetDraft, 'abbreviation'>) => s.abbreviation.toLowerCase();

/** The snippets offered for an engine: the user's first, then built-ins they do not replace. */
export function activeSnippets(
  dialect: SnippetDraft['dialect'] = 'postgresql',
  user: Snippet[] = useSnippets.getState().user,
): SnippetDraft[] {
  const fits = (s: SnippetDraft) => s.dialect === 'any' || s.dialect === dialect;
  const mine = user.filter(fits);
  const replaced = new Set(mine.map(key));
  return [...mine, ...BUILTIN_SNIPPETS.filter((s) => fits(s) && !replaced.has(key(s)))];
}

/** The snippet an abbreviation expands to (case-insensitive), if any. */
export function snippetFor(abbreviation: string): SnippetDraft | undefined {
  const k = abbreviation.toLowerCase();
  return activeSnippets().find((s) => key(s) === k);
}
