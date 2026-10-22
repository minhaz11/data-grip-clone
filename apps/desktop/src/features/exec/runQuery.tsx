import { useWorkspace } from '../../app/workspaceStore';
import { askConfirm, askPasswordAndConnect } from '../../app/dialogs';
import type { StatementRequest } from '../../ipc/types';
import { blockedOnReadOnly, classify, modifies } from '../../lib/sql/classify';
import { splitStatements, statementAt } from '../../lib/sql/statements';
import { useConnections } from '../connections/connectionsStore';
import { effectiveColor } from '../connections/model';
import { useSessions } from '../connections/sessionsStore';
import { activeEditor } from '../editor/editorHandle';
import { isRunning, useExec } from './execStore';
import { keyOf, sessionOf, useTx } from './txStore';

export type RunMode = 'current' | 'script';

/** What a run would execute: the selection, else the statement at the caret (or the whole script). */
export function pickStatements(
  text: string,
  selection: { start: number; end: number },
  caret: number,
  mode: RunMode,
): StatementRequest[] {
  if (selection.end > selection.start) {
    const selected = text.slice(selection.start, selection.end);
    return splitStatements(selected).map((s) => ({
      sql: selected.slice(s.start, s.end),
      offset: selection.start + s.start,
    }));
  }
  if (mode === 'script')
    return splitStatements(text).map((s) => ({ sql: text.slice(s.start, s.end), offset: s.start }));
  const span = statementAt(text, caret);
  return span ? [{ sql: text.slice(span.start, span.end), offset: span.start }] : [];
}

const firstLine = (sql: string) => {
  const line = sql.split('\n').find((l) => l.trim() && !l.trim().startsWith('--')) ?? sql;
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
};

/** Runs from the active console. Every guard here applies equally to future AI-produced SQL. */
export async function runFromEditor(mode: RunMode): Promise<void> {
  const ws = useWorkspace.getState();
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
  const editor = activeEditor();
  if (!tab || !editor) return;
  const exec = useExec.getState();
  if (isRunning(exec.runs[tab.id])) return;

  const source = useConnections.getState().items.find((s) => s.id === tab.sourceId);
  if (!source) {
    exec.reject(tab.id, '', '', 'Choose a data source for this console in the toolbar first.');
    ws.setBottomCollapsed(false);
    return;
  }

  const statements = pickStatements(
    editor.getText(),
    editor.getSelection(),
    editor.getCaret(),
    mode,
  );
  if (statements.length === 0) return;

  // Guards: read-only blocks, destructive or production writes need explicit confirmation.
  const classified = statements.map((s) => ({ ...s, c: classify(s.sql) }));
  const modifying = classified.filter((s) => modifies(s.c));
  const blocked = classified.filter((s) => blockedOnReadOnly(s.c));
  if (source.readOnly && blocked.length > 0) {
    const reason = blocked[0]?.c.unlocksWrites;
    exec.reject(
      tab.id,
      source.id,
      source.name,
      `"${source.name}" is read-only; not running ${blocked.length === 1 ? 'a statement' : `${blocked.length} statements`} that ${reason ?? 'may modify data or schema'}: ${firstLine(blocked[0]?.sql ?? '')}`,
    );
    ws.setBottomCollapsed(false);
    return;
  }
  const destructive = classified.filter((s) => s.c.destructive);
  const production = source.environment === 'production' && modifying.length > 0;
  if (destructive.length > 0 || production) {
    const color = effectiveColor(source);
    const ok = await askConfirm({
      title: production ? `Modify production: ${source.name}?` : 'Run destructive statement?',
      confirmLabel: 'Run',
      danger: true,
      body: (
        <>
          {production && (
            <p>
              <span
                className="mr-1.5 inline-block h-2 w-2 rounded-full"
                style={{ background: color ?? undefined }}
              />
              <strong>{source.name}</strong> is a <strong>production</strong> data source.
            </p>
          )}
          <ul className="max-h-48 list-disc space-y-1 overflow-auto pl-5 font-mono text-[12px]">
            {(destructive.length > 0 ? destructive : modifying).map((s) => (
              <li key={s.offset}>
                {firstLine(s.sql)}
                {s.c.destructive && (
                  <span className="ml-2 font-sans text-danger">({s.c.destructive})</span>
                )}
              </li>
            ))}
          </ul>
        </>
      ),
    });
    if (!ok) return;
  }

  if (useSessions.getState().byId[source.id]?.state !== 'connected') {
    const error = await useSessions.getState().connect(source.id);
    if (error?.connectKind === 'password_required') {
      if (!(await askPasswordAndConnect(source))) return;
    } else if (error) {
      exec.reject(
        tab.id,
        source.id,
        source.name,
        `Could not connect to "${source.name}": ${error.message}${error.hint ? ` ${error.hint}` : ''}`,
      );
      ws.setBottomCollapsed(false);
      return;
    }
  }

  const session = sessionOf(tab);
  if (!session) return;
  const txMode = useTx.getState().states[keyOf(session)]?.settings.mode ?? source.txMode;
  editor.clearMarkers();
  ws.setBottomCollapsed(false);
  const options = { schema: tab.schema ?? null, txMode };
  await exec.start(tab.id, session, source.name, statements, options, (failed) => {
    const e = failed.error;
    if (!e) return;
    // Server positions are 1-based characters within the statement; underline the next word.
    const start = failed.offset + Math.max(0, (e.position ?? 1) - 1);
    const rest = failed.sql.slice(start - failed.offset);
    const word = /^[\w."$]+/.exec(rest)?.[0].length ?? 1;
    editor.markError(start, start + word, e.message);
    if (e.position) editor.revealOffset(start);
  });
}
