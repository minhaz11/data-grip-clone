import { useId, useState } from 'react';
import { askConfirm, askCustom } from '../../app/dialogs';
import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { Modal } from '../../components/ui/Modal';
import type { ConnectionProfile } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { useConnections } from '../connections/connectionsStore';
import { useNotifications } from '../notifications/notifications';

/** Client-side mirror of the backend's console name rules (`quarry-workspace`). */
export function consoleNameProblem(name: string): string | null {
  if (!name) {
    return 'Enter a name.';
  }
  if ([...name].length > 100) {
    return 'At most 100 characters.';
  }
  if (/^[. ]|[. ]$/.test(name) || name.includes('..')) {
    return 'The name cannot start or end with a dot or space, or contain "..".';
  }
  if (!/^[\p{L}\p{N}_. -]+$/u.test(name)) {
    return "Use letters, digits, spaces, '.', '-' or '_'.";
  }
  return null;
}

function RenameDialog({
  current,
  onRename,
  onClose,
}: {
  current: string;
  onRename(name: string): Promise<void>;
  onClose(): void;
}) {
  const [name, setName] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const problem = consoleNameProblem(name.trim());

  async function submit() {
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await onRename(name.trim());
      onClose();
    } catch (e) {
      setError(toAppError(e).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Rename Console"
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
            onClick={() => void submit()}
            disabled={busy}
            className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50"
          >
            Rename
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={id} className="mb-1 block">
          New name
        </label>
        <div className="flex items-center gap-1">
          <input
            id={id}
            className="w-full rounded border border-border bg-bg px-2 py-1 font-mono aria-[invalid=true]:border-danger"
            value={name}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
          />
          <span className="text-muted">.sql</span>
        </div>
        {error && (
          <p id={`${id}-error`} role="alert" className="mt-1 text-danger">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

/** Asks for a new name and renames the console of tab `tabId`. */
export async function renameConsole(tabId: string): Promise<void> {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId);
  if (!isConsole(tab)) {
    return;
  }
  await askCustom<true>((done) => (
    <RenameDialog
      current={tab.console}
      onRename={(name) => useWorkspace.getState().renameConsole(tabId, name)}
      onClose={() => done(null)}
    />
  ));
}

/** Asks first, then deletes the console file of tab `tabId` and closes the tab. */
export async function deleteConsole(tabId: string): Promise<void> {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId);
  if (!isConsole(tab)) {
    return;
  }
  const ok = await askConfirm({
    title: 'Delete Console',
    confirmLabel: 'Delete',
    danger: true,
    body: (
      <p>
        Delete <strong className="font-mono">{tab.console}.sql</strong>? Its text is removed from
        disk and cannot be reopened.
      </p>
    ),
  });
  if (!ok) {
    return;
  }
  try {
    await useWorkspace.getState().deleteConsole(tabId);
  } catch (e) {
    useNotifications
      .getState()
      .notify(`Could not delete ${tab.console}.sql: ${toAppError(e).message}`, 'error');
  }
}

export async function duplicateConsole(tabId: string): Promise<void> {
  try {
    await useWorkspace.getState().duplicateConsole(tabId);
  } catch (e) {
    useNotifications.getState().notify(`Could not duplicate: ${toAppError(e).message}`, 'error');
  }
}

function AttachDialog({
  console,
  sources,
  onDone,
}: {
  console: string;
  sources: ConnectionProfile[];
  onDone(sourceId: string | null): void;
}) {
  const [picked, setPicked] = useState(
    useConnections.getState().selectedId ?? sources[0]?.id ?? '',
  );
  const id = useId();
  return (
    <Modal
      title="Attach Data Source"
      onClose={() => onDone(null)}
      footer={
        <>
          <button
            type="button"
            onClick={() => onDone(null)}
            className="rounded border border-border px-3 py-1 hover:bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onDone(picked || null)}
            disabled={!picked}
            className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50"
          >
            Attach and Run
          </button>
        </>
      }
    >
      <p className="mb-2">
        <span className="font-mono">{console}.sql</span> is not attached to a data source yet.
      </p>
      <label htmlFor={id} className="mb-1 block">
        Run it against
      </label>
      <select
        id={id}
        value={picked}
        onChange={(e) => setPicked(e.target.value)}
        className="w-full rounded border border-border bg-bg px-2 py-1"
      >
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </Modal>
  );
}

/** Asks which data source a scratch console should run against; `null` on Cancel. */
export function askAttach(console: string, sources: ConnectionProfile[]): Promise<string | null> {
  return askCustom<string>((done) => (
    <AttachDialog console={console} sources={sources} onDone={done} />
  ));
}
