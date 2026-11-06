import { useId, useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import type { ConnectionProfile, Folder } from '../../ipc/types';
import { useConnections } from './connectionsStore';

const inputClass = 'w-full rounded border border-border bg-bg px-2 py-1';

function Footer({
  busy,
  label,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  label: string;
  onCancel(): void;
  onSubmit(): void;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onCancel}
        className="rounded border border-border px-3 py-1 hover:bg-hover"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onSubmit}
        disabled={busy}
        className="rounded bg-accent px-3 py-1 text-accent-fg disabled:opacity-50"
      >
        {label}
      </button>
    </>
  );
}

/** Folder name and color; data sources without their own color inherit it. */
export function FolderDialog({ folder, onClose }: { folder: Folder; onClose(): void }) {
  const updateFolder = useConnections((s) => s.updateFolder);
  const [name, setName] = useState(folder.name);
  const [color, setColor] = useState<string | null>(folder.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const colorId = useId();

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await updateFolder(folder.id, name, color);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Folder: ${folder.name}`}
      onClose={onClose}
      footer={<Footer busy={busy} label="Save" onCancel={onClose} onSubmit={() => void save()} />}
    >
      <form
        className="grid grid-cols-[90px_1fr] items-center gap-x-3 gap-y-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label htmlFor={nameId}>Name</label>
        <input
          id={nameId}
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor={colorId}>Color</label>
        <div className="flex items-center gap-2">
          <input
            id={colorId}
            type="color"
            value={color ?? '#888888'}
            onChange={(e) => setColor(e.target.value)}
            className="h-7 w-9 shrink-0 cursor-pointer rounded border border-border bg-bg"
          />
          {color ? (
            <button
              type="button"
              onClick={() => setColor(null)}
              className="text-[12px] text-muted underline"
            >
              No color
            </button>
          ) : (
            <span className="text-[12px] text-muted">No color</span>
          )}
        </div>
        <span />
        <p className="text-[12px] text-muted">
          Data sources in this folder use its color unless they have their own.
        </p>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
      {error && (
        <p role="alert" className="mt-3 text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}

/** Keyboard-friendly alternative to dragging a data source into a folder. */
export function MoveDialog({ profile, onClose }: { profile: ConnectionProfile; onClose(): void }) {
  const folders = useConnections((s) => s.folders);
  const items = useConnections((s) => s.items);
  const move = useConnections((s) => s.move);
  const [target, setTarget] = useState(profile.folderId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();

  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Last in the chosen folder.
      await move(profile.id, target || null, items.length);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Move ${profile.name}`}
      onClose={onClose}
      footer={<Footer busy={busy} label="Move" onCancel={onClose} onSubmit={() => void save()} />}
    >
      <label htmlFor={selectId} className="mb-1 block">
        Folder
      </label>
      <select
        id={selectId}
        className={inputClass}
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      >
        <option value="">(top level)</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="mt-3 text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
