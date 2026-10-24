import clsx from 'clsx';
import { useEffect, useId, useMemo, useState } from 'react';
import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { Modal } from '../../components/ui/Modal';
import { backend } from '../../ipc/client';
import type { RevisionInfo, RevisionReason } from '../../ipc/types';
import { diffLines } from '../../lib/diff';
import { LineDiff } from '../../components/ui/LineDiff';
import { toAppError } from '../../lib/errors';
import { useNotifications } from '../notifications/notifications';
import { formatBytes } from '../import/model';

export const REASON_LABEL: Record<RevisionReason, string> = {
  auto: 'Edit',
  beforeDeletion: 'Before text was deleted',
  external: 'Changed outside Quarry',
  beforeRun: 'Before run',
  beforeFormat: 'Before format',
  beforeRestore: 'Before restore',
  beforeDelete: 'Before the console was deleted',
};

/** Earlier versions of a console, a diff against the current text, and Restore. */
export function LocalHistoryDialog({ tabId, onClose }: { tabId: string; onClose(): void }) {
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === tabId));
  const consoleName = isConsole(tab) ? tab.console : '';
  const current = isConsole(tab) ? tab.text : '';
  const [revisions, setRevisions] = useState<RevisionInfo[] | null>(null);
  const [active, setActive] = useState(0);
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listId = useId();

  useEffect(() => {
    let live = true;
    // Pending edits first, so the history and the comparison are current.
    void useWorkspace
      .getState()
      .flushAll()
      .then(() => backend.revisionsList(consoleName))
      .then((list) => live && setRevisions(list))
      .catch((e) => live && setError(toAppError(e).message));
    return () => {
      live = false;
    };
  }, [consoleName]);

  const selected = revisions?.[active];
  const selectedId = selected?.id;
  useEffect(() => {
    if (selectedId === undefined || texts[selectedId] !== undefined) {
      return;
    }
    let live = true;
    backend
      .revisionRead(selectedId)
      .then((text) => live && setTexts((t) => ({ ...t, [selectedId]: text })))
      .catch((e) => live && setError(toAppError(e).message));
    return () => {
      live = false;
    };
  }, [selectedId, texts]);

  const revisionText = selectedId === undefined ? undefined : texts[selectedId];
  const diff = useMemo(
    () => (revisionText === undefined ? undefined : diffLines(revisionText, current)),
    [revisionText, current],
  );

  async function restore() {
    if (!selected || !isConsole(tab)) {
      return;
    }
    setBusy(true);
    try {
      await useWorkspace.getState().flushAll();
      const text = await backend.revisionRestore(selected.id);
      useWorkspace.getState().replaceText(tab.id, text);
      useNotifications
        .getState()
        .notify(
          `Restored ${consoleName}.sql from ${new Date(selected.createdAt).toLocaleString()}. The replaced text is in the local history.`,
        );
      onClose();
    } catch (e) {
      setError(toAppError(e).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Local History: ${consoleName}.sql`}
      onClose={onClose}
      width={900}
      initialFocus="[role=listbox], button"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Close
          </button>
          <button
            type="button"
            disabled={!selected || busy || revisionText === current}
            onClick={() => void restore()}
            className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50"
          >
            Restore This Version
          </button>
        </>
      }
    >
      {revisions === null && !error && <p className="text-muted">Loading…</p>}
      {revisions?.length === 0 && (
        <p className="text-muted">
          No earlier versions yet. Versions are kept while you edit (every few minutes), before each
          run or format, and whenever most of the text is deleted.
        </p>
      )}
      {revisions && revisions.length > 0 && (
        <div className="grid h-[420px] grid-cols-[280px_1fr] gap-3">
          <ul
            id={listId}
            role="listbox"
            aria-label="Versions"
            tabIndex={0}
            aria-activedescendant={selected ? `${listId}-${selected.id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const delta = e.key === 'ArrowDown' ? 1 : -1;
                setActive((i) => Math.max(0, Math.min(revisions.length - 1, i + delta)));
              }
            }}
            className="overflow-auto rounded border border-border bg-bg py-1 outline-none"
          >
            {revisions.map((r, i) => (
              <li
                key={r.id}
                id={`${listId}-${r.id}`}
                role="option"
                aria-selected={i === active}
                onClick={() => setActive(i)}
                className={clsx('cursor-default px-2 py-1', i === active && 'bg-selected')}
              >
                <span className="block">{new Date(r.createdAt).toLocaleString()}</span>
                <span className="block text-[11px] text-muted">
                  {REASON_LABEL[r.reason]} · {formatBytes(r.size)}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted">
                  {r.firstLine}
                </span>
              </li>
            ))}
          </ul>
          <div
            role="region"
            aria-label="Changes from this version to the current text"
            className="overflow-auto rounded border border-border bg-bg font-mono text-[12px]"
          >
            {revisionText === undefined && <p className="p-2 text-muted">Loading…</p>}
            {diff === null && (
              <p className="p-2 text-muted">
                These versions are too large to compare line by line.
              </p>
            )}
            {diff &&
              (diff.every((l) => l.kind === 'same') ? (
                <p className="p-2 font-sans text-muted">Same as the current text.</p>
              ) : (
                <LineDiff lines={diff} />
              ))}
          </div>
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
