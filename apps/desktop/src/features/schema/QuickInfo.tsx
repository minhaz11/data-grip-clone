import type { ReactNode } from 'react';
import { Modal } from '../../components/ui/Modal';
import type { ObjectRef } from '../../ipc/types';
import { columnDefault, formatBytes, useObjectDetails } from './ObjectViewer';

export interface QuickInfoTarget {
  sourceId: string;
  object: ObjectRef;
  /** A column of `object`, or the object itself when absent. */
  column?: string;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words font-mono">{children}</dd>
    </>
  );
}

/** Summary of a table-like object or one of its columns (REQ-EXPL-07). */
export function QuickInfo({ target, onClose }: { target: QuickInfoTarget; onClose(): void }) {
  const { sourceId, object, column } = target;
  const { connected, value } = useObjectDetails(sourceId, object);
  const qualified = `${object.schema}.${object.name}`;
  const title = column ? `${object.name}.${column}` : qualified;

  let body: ReactNode;
  if (!connected) {
    body = <p className="text-muted">Connect to the data source to see details.</p>;
  } else if (!value) {
    body = <p role="status">Loading…</p>;
  } else if ('error' in value) {
    body = (
      <p role="alert" className="text-danger">
        {value.error}
      </p>
    );
  } else if (!value.details) {
    body = <p className="text-muted">{qualified} no longer exists.</p>;
  } else if (column) {
    const c = value.details.columns.find((x) => x.name === column);
    body = c ? (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <Fact label="Table">{qualified}</Fact>
        <Fact label="Type">{c.typeName}</Fact>
        <Fact label="Nullable">{c.nullable ? 'yes' : 'no (NOT NULL)'}</Fact>
        {columnDefault(c) && <Fact label="Default">{columnDefault(c)}</Fact>}
        {c.primaryKey && <Fact label="Key">primary key</Fact>}
        {c.comment && <Fact label="Comment">{c.comment}</Fact>}
      </dl>
    ) : (
      <p className="text-muted">The column no longer exists.</p>
    );
  } else {
    const d = value.details;
    body = (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <Fact label="Kind">{object.objectType.replace('_', ' ')}</Fact>
        {d.comment && <Fact label="Comment">{d.comment}</Fact>}
        <Fact label="Columns">{d.columns.length}</Fact>
        {d.rowEstimate !== undefined && d.rowEstimate !== null && (
          <Fact label="Rows (estimate)">{d.rowEstimate.toLocaleString()}</Fact>
        )}
        {d.totalBytes !== undefined && d.totalBytes !== null && (
          <Fact label="Size">{formatBytes(d.totalBytes)}</Fact>
        )}
        {d.references.length > 0 && (
          <Fact label="References">
            {[...new Set(d.references.map((k) => `${k.toSchema}.${k.toTable}`))].join(', ')}
          </Fact>
        )}
        {d.referencedBy.length > 0 && (
          <Fact label="Referenced by">
            {[...new Set(d.referencedBy.map((k) => `${k.fromSchema}.${k.fromTable}`))].join(', ')}
          </Fact>
        )}
      </dl>
    );
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border px-3 py-1 hover:bg-hover"
        >
          Close
        </button>
      }
    >
      {body}
    </Modal>
  );
}
