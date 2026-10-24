import { useState } from 'react';
import type { ConnectionProfile, DropObject, RenameObject, TableName } from '../../ipc/types';
import { ChangeDialog } from './ChangeDialog';

const check = 'flex items-center gap-2';
const field = 'rounded border border-border bg-bg px-2 py-1';

/** Drop one or more objects; CASCADE or several objects need the name typed (REQ-SCHEMA-05). */
export function DropDialog({
  source,
  objects,
  label,
  onApplied,
  onClose,
}: {
  source: ConnectionProfile;
  objects: DropObject[];
  /** What is dropped, e.g. `table shop.orders`. */
  label: string;
  onApplied(): void;
  onClose(): void;
}) {
  const [ifExists, setIfExists] = useState(false);
  const [cascade, setCascade] = useState(false);
  const confirmName =
    cascade || objects.length > 1 ? label.slice(label.lastIndexOf(' ') + 1) : undefined;
  return (
    <ChangeDialog
      title={`Drop ${label}`}
      source={source}
      change={{ kind: 'drop', objects, ifExists, cascade }}
      applyLabel="Drop"
      danger
      confirmName={confirmName}
      onApplied={onApplied}
      onClose={onClose}
    >
      <p>
        Drop <strong className="font-mono">{label}</strong>? This cannot be undone.
      </p>
      <div className="flex gap-4">
        <label className={check}>
          <input
            type="checkbox"
            checked={ifExists}
            onChange={(e) => setIfExists(e.target.checked)}
          />
          IF EXISTS
        </label>
        <label className={check}>
          <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} />
          CASCADE (also drop objects that depend on it)
        </label>
      </div>
    </ChangeDialog>
  );
}

/** Remove every row of tables (REQ-SCHEMA-06). */
export function TruncateDialog({
  source,
  tables,
  onApplied,
  onClose,
}: {
  source: ConnectionProfile;
  tables: TableName[];
  onApplied(): void;
  onClose(): void;
}) {
  const [restartIdentity, setRestartIdentity] = useState(false);
  const [cascade, setCascade] = useState(false);
  const names = tables.map((t) => `${t.schema}.${t.name}`).join(', ');
  return (
    <ChangeDialog
      title={`Truncate ${names}`}
      source={source}
      change={{ kind: 'truncate', tables, restartIdentity, cascade }}
      applyLabel="Truncate"
      danger
      confirmName={cascade ? tables[0]?.name : undefined}
      onApplied={onApplied}
      onClose={onClose}
    >
      <p>
        Remove <strong>every row</strong> of <strong className="font-mono">{names}</strong>? This
        cannot be undone.
      </p>
      <div className="flex gap-4">
        <label className={check}>
          <input
            type="checkbox"
            checked={restartIdentity}
            onChange={(e) => setRestartIdentity(e.target.checked)}
          />
          RESTART IDENTITY
        </label>
        <label className={check}>
          <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} />
          CASCADE (also truncate tables that reference it)
        </label>
      </div>
    </ChangeDialog>
  );
}

/** Rename a table, view, materialized view, column or schema (REQ-SCHEMA-07). */
export function RenameDialog({
  source,
  object,
  current,
  onApplied,
  onClose,
}: {
  source: ConnectionProfile;
  object: RenameObject;
  current: string;
  onApplied(newName: string): void;
  onClose(): void;
}) {
  const [name, setName] = useState(current);
  const changed = name.trim() !== '' && name !== current;
  return (
    <ChangeDialog
      title={`Rename ${current}`}
      source={source}
      change={changed ? { kind: 'rename', object, newName: name } : null}
      applyLabel="Rename"
      width={520}
      onApplied={() => onApplied(name)}
      onClose={onClose}
    >
      <label className="flex flex-col gap-1">
        New name
        <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
      </label>
    </ChangeDialog>
  );
}
