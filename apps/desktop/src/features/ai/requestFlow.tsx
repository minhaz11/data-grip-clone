import { askCustom } from '../../app/dialogs';
import { backend } from '../../ipc/client';
import type { AiConsent, AiPreview, AiTask, ObjectRef } from '../../ipc/types';
import { tablesInStatement } from '../../lib/sql/completionContext';
import { splitStatements } from '../../lib/sql/statements';
import { useSessions } from '../connections/sessionsStore';
import { useConnections } from '../connections/connectionsStore';
import { catalogObjects } from '../editor/catalog';
import { fromCatalogNode, objectRef } from '../navigation/objects';
import { ConsentDialog, RowConsentDialog, type ConsentChoice } from './ConsentDialog';

export interface AiRequestInput {
  sourceId: string;
  task: AiTask;
  /** The selection or the statement at the caret. */
  sql: string;
  /** The console's schema, for resolving unqualified names. */
  schema: string | null;
}

/**
 * Tables and views the SQL refers to, resolved in the data source's catalog like Go to DDL does
 * (the console's schema, then `public`, then a unique match). Nothing when not connected.
 */
export async function referencedObjects(
  sourceId: string,
  sql: string,
  schema: string | null,
): Promise<ObjectRef[]> {
  if (useSessions.getState().byId[sourceId]?.state !== 'connected') {
    return [];
  }
  const catalog = (await catalogObjects(sourceId))
    .map((n) => fromCatalogNode(sourceId, n))
    .filter((o) => objectRef(o) !== null);
  const searchPath = [...(schema ? [schema] : []), 'public'];
  const found: ObjectRef[] = [];
  const seen = new Set<string>();
  for (const span of splitStatements(sql)) {
    for (const ref of tablesInStatement(sql.slice(span.start, span.end))) {
      const named = catalog.filter((o) => o.name === ref.table);
      const match = ref.schema
        ? named.find((o) => o.schema === ref.schema)
        : (searchPath.map((s) => named.find((o) => o.schema === s)).find(Boolean) ??
          (named.length === 1 ? named[0] : undefined));
      const object = match ? objectRef(match) : null;
      const key = object ? `${object.schema}.${object.name}` : '';
      if (object && !seen.has(key)) {
        seen.add(key);
        found.push(object);
      }
    }
  }
  return found;
}

/** Asks how much of the data source may be sent; the saved consent, or `null` on Cancel. */
export async function chooseConsent(
  sourceId: string,
  consent: AiConsent,
): Promise<AiConsent | null> {
  const profile = useConnections.getState().items.find((c) => c.id === sourceId);
  const choice = await askCustom<ConsentChoice>((done) => (
    <ConsentDialog
      sourceName={profile?.name ?? 'this data source'}
      production={profile?.environment === 'production'}
      consent={consent}
      onSubmit={done}
      onCancel={() => done(null)}
    />
  ));
  if (!choice) {
    return null;
  }
  return backend.aiConsentSet(sourceId, choice.level, choice.remember, choice.rowsAlways);
}

/**
 * Everything before Send: the consent (asked the first time), the objects the SQL uses, the
 * preview built in Rust, and the row prompt when sample rows are allowed. Resolves to the
 * preview to show, or `null` when the user cancelled. Rejects with the backend's error.
 */
export async function prepareAiRequest(input: AiRequestInput): Promise<AiPreview | null> {
  let consent = await backend.aiConsentGet(input.sourceId);
  if (!consent.decided) {
    const chosen = await chooseConsent(input.sourceId, consent);
    if (!chosen) {
      return null;
    }
    consent = chosen;
  }
  const objects =
    consent.level === 'none'
      ? []
      : await referencedObjects(input.sourceId, input.sql, input.schema);
  const request = {
    connectionId: input.sourceId,
    task: input.task,
    sql: input.sql,
    objects,
    includeRows: false,
  };
  const preview = await backend.aiContextPreview(request);
  if (preview.rowOffer.length === 0) {
    return preview;
  }
  const include = await askCustom<boolean>((done) => (
    <RowConsentDialog
      tables={preview.rowOffer}
      onAnswer={(value) => done(value)}
      onCancel={() => done(null)}
    />
  ));
  if (include === null) {
    return null;
  }
  return include ? backend.aiContextPreview({ ...request, includeRows: true }) : preview;
}
