import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { askConfirm, askCustom } from '../../app/dialogs';
import { connectSource } from '../connections/connectFlow';
import { useSettings } from '../../app/settingsStore';
import type { Cell, Settings, StatementRequest } from '../../ipc/types';
import { blockedOnReadOnly, classify, modifies } from '../../lib/sql/classify';
import { bindParameters, findParameters, parameterNames } from '../../lib/sql/params';
import { splitStatements, statementAt, statementContaining } from '../../lib/sql/statements';
import { useConnections } from '../connections/connectionsStore';
import { effectiveColor } from '../connections/model';
import { useSessions } from '../connections/sessionsStore';
import { activeEditor } from '../editor/editorHandle';
import { isRunning, useExec, type RunStatement } from './execStore';
import { ParamsDialog, StatementChooser, type ChoosableStatement } from './RunDialogs';
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

export interface RunPlan {
  statements: StatementRequest[];
  /** The user picks from these first (the chooser settings). */
  ask?: { title: string; options: StatementRequest[]; allowAll: boolean };
}

/**
 * What Run executes, following the settings (REQ-EDIT-04): a selection of several statements
 * runs them all or asks; a caret outside every statement runs the nearest one or asks.
 */
export function planRun(
  text: string,
  selection: { start: number; end: number },
  caret: number,
  mode: RunMode,
  policy: Pick<Settings, 'runOutsideStatement' | 'runSelection'>,
): RunPlan {
  const statements = pickStatements(text, selection, caret, mode);
  if (selection.end > selection.start) {
    return statements.length > 1 && policy.runSelection === 'ask'
      ? {
          statements,
          ask: { title: 'Run which statements?', options: statements, allowAll: true },
        }
      : { statements };
  }
  if (mode === 'current' && !statementContaining(text, caret)) {
    const all = pickStatements(text, selection, caret, 'script');
    if (all.length > 1 && policy.runOutsideStatement === 'ask') {
      return { statements, ask: { title: 'Run which statement?', options: all, allowAll: false } };
    }
  }
  return { statements };
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
  if (!isConsole(tab) || !editor) return;
  const exec = useExec.getState();
  if (isRunning(exec.runs[tab.id])) return;

  const source = useConnections.getState().items.find((s) => s.id === tab.sourceId);
  if (!source) {
    exec.reject(tab.id, '', '', 'Choose a data source for this console in the toolbar first.');
    ws.setBottomCollapsed(false);
    return;
  }

  const plan = planRun(
    editor.getText(),
    editor.getSelection(),
    editor.getCaret(),
    mode,
    useSettings.getState().settings,
  );
  let statements: StatementRequest[] = plan.statements;
  const ask = plan.ask;
  if (ask) {
    const chosen = await askCustom<ChoosableStatement[]>((done) => (
      <StatementChooser
        title={ask.title}
        statements={ask.options}
        allowAll={ask.allowAll}
        onDone={done}
      />
    ));
    if (!chosen) {
      return;
    }
    statements = chosen;
  }
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

  // Parameters (`:name`, `${name}`, `$1`) are asked for once per run and bound, not spliced in.
  let toRun: RunStatement[] = statements;
  const names = parameterNames(statements.map((s) => s.sql));
  if (names.length > 0) {
    const values = await askCustom<Record<string, Cell>>((done) => (
      <ParamsDialog names={names} initial={tab.params ?? {}} onDone={done} />
    ));
    if (!values) {
      return;
    }
    ws.setParams(tab.id, values);
    toRun = statements.map((s) => {
      const own = [...new Set(findParameters(s.sql).map((p) => p.name))];
      if (own.length === 0) {
        return s;
      }
      const bound = bindParameters(s.sql, values);
      return {
        sql: bound.sql,
        offset: s.offset,
        params: bound.params,
        text: s.sql,
        paramValues: own.map((n) => [n, values[n] ?? null] as [string, Cell]),
      };
    });
  }

  if (useSessions.getState().byId[source.id]?.state !== 'connected') {
    const outcome = await connectSource(source);
    if (!outcome.ok) {
      const error = outcome.error;
      if (error) {
        exec.reject(
          tab.id,
          source.id,
          source.name,
          `Could not connect to "${source.name}": ${error.message}${error.hint ? ` ${error.hint}` : ''}`,
        );
        ws.setBottomCollapsed(false);
      }
      return;
    }
  }

  const session = sessionOf(tab);
  if (!session) return;
  const txMode = useTx.getState().states[keyOf(session)]?.settings.mode ?? source.txMode;
  editor.clearMarkers();
  ws.setBottomCollapsed(false);
  const options = { schema: tab.schema ?? null, txMode };
  await exec.start(tab.id, session, source.name, toRun, options, (failed) => {
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
