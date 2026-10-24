import { askChoice } from '../../app/dialogs';
import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { SessionKey, SessionState } from '../../ipc/types';
import { useConnections } from '../connections/connectionsStore';
import { useSessions } from '../connections/sessionsStore';
import { keyOf, openTransactions, sessionOf, useTx } from './txStore';

function describe(session: SessionKey, status?: SessionState['status']): string {
  const source =
    useConnections.getState().items.find((c) => c.id === session.sourceId)?.name ??
    session.sourceId;
  const where = session.console ? `console ${session.console}` : 'shared session';
  return `${source}, ${where}${status === 'failed' ? ' (failed: can only be rolled back)' : ''}`;
}

function list(open: { session: SessionKey; status?: SessionState['status'] }[]) {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {open.map((s) => (
        <li key={keyOf(s.session)}>{describe(s.session, s.status)}</li>
      ))}
    </ul>
  );
}

/**
 * Before an action that would end open transactions, asks whether to commit or roll them back.
 * Resolves true once they are resolved (the action may go ahead), false on Cancel. Nothing is
 * ever committed or discarded without this choice (REQ-ERR-09).
 */
export async function resolveTransactions(open: SessionState[], title: string): Promise<boolean> {
  if (open.length === 0) {
    return true;
  }
  const tx = useTx.getState();
  const forEach = (f: (s: SessionKey) => Promise<void>) => async () => {
    for (const s of open) {
      await f(s.session);
    }
  };
  const anyCommittable = open.some((s) => s.status === 'active');
  return askChoice({
    title,
    body: (
      <>
        <p>
          {open.length === 1 ? 'This transaction is' : `These ${open.length} transactions are`}{' '}
          still open:
        </p>
        {list(open)}
      </>
    ),
    choices: [
      ...(anyCommittable ? [{ label: 'Commit', run: forEach(tx.commit) }] : []),
      { label: 'Roll back', danger: true, run: forEach(tx.rollback) },
    ],
  });
}

/** Closes a console tab; a console with its own session closes that session too. */
export async function closeConsole(tabId: string): Promise<void> {
  const ws = useWorkspace.getState();
  const tab = ws.tabs.find((t) => t.id === tabId);
  if (!tab) {
    return;
  }
  if (!isConsole(tab)) {
    await ws.closeTab(tabId);
    return;
  }
  const own = tab.ownSession ? sessionOf(tab) : null;
  if (own) {
    const state = useTx.getState().states[keyOf(own)];
    const open = state?.open && state.status !== 'idle' ? [state] : [];
    if (!(await resolveTransactions(open, `Close ${tab.console}?`))) {
      return;
    }
  }
  await ws.closeTab(tabId);
  if (own) {
    void backend.sessionClose(own).catch(() => {});
  }
}

/** Switches a console between its own session and the shared one, resolving its transaction. */
export async function setOwnSession(tabId: string, own: boolean): Promise<void> {
  const ws = useWorkspace.getState();
  const tab = ws.tabs.find((t) => t.id === tabId);
  if (!isConsole(tab) || !!tab.ownSession === own) {
    return;
  }
  const previous = tab.ownSession ? sessionOf(tab) : null;
  if (previous) {
    const state = useTx.getState().states[keyOf(previous)];
    const open = state?.open && state.status !== 'idle' ? [state] : [];
    if (!(await resolveTransactions(open, 'Switch to the shared session?'))) {
      return;
    }
    void backend.sessionClose(previous).catch(() => {});
  }
  ws.setOwnSession(tabId, own);
}

/** Binds a console to another data source; its own session (and transaction) is closed first. */
export async function changeSource(tabId: string, sourceId: string | null): Promise<void> {
  const ws = useWorkspace.getState();
  const tab = ws.tabs.find((t) => t.id === tabId);
  if (!isConsole(tab) || tab.sourceId === sourceId) {
    return;
  }
  const own = tab.ownSession ? sessionOf(tab) : null;
  if (own) {
    const state = useTx.getState().states[keyOf(own)];
    const open = state?.open && state.status !== 'idle' ? [state] : [];
    if (!(await resolveTransactions(open, 'Change the data source?'))) {
      return;
    }
    void backend.sessionClose(own).catch(() => {});
  }
  ws.setSource(tabId, sourceId);
}

/** Disconnects a data source after its open transactions are resolved. */
export async function disconnectSource(sourceId: string): Promise<boolean> {
  if (!(await resolveTransactions(openTransactions(sourceId), 'Disconnect?'))) {
    return false;
  }
  await useSessions.getState().disconnect(sourceId);
  return true;
}

/** The window was closed with open transactions (the backend kept it open and asks). */
export async function askQuit(open: SessionKey[]): Promise<void> {
  const states = useTx.getState().states;
  await askChoice({
    title: 'Quit with open transactions?',
    body: (
      <>
        <p>Quarry is about to close, but these transactions are still open:</p>
        {list(open.map((session) => ({ session, status: states[keyOf(session)]?.status })))}
      </>
    ),
    choices: [
      {
        label: 'Commit and quit',
        run: async () => {
          await backend.appQuit('commit');
        },
      },
      {
        label: 'Roll back and quit',
        danger: true,
        run: async () => {
          await backend.appQuit('rollback');
        },
      },
    ],
  });
}
