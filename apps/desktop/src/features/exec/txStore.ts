import { create } from 'zustand';
import { backend } from '../../ipc/client';
import type { SessionKey, SessionState, TxSettings } from '../../ipc/types';

/** Stable map key for a session. */
export function keyOf(session: SessionKey): string {
  return `${session.sourceId}\u001f${session.console ?? ''}`;
}

/** The session a console runs in: its own, or its data source's shared one. */
export function sessionOf(tab: {
  sourceId: string | null;
  console: string;
  ownSession?: boolean;
}): SessionKey | null {
  if (!tab.sourceId) {
    return null;
  }
  return tab.ownSession
    ? { sourceId: tab.sourceId, console: tab.console }
    : { sourceId: tab.sourceId };
}

export function sameSession(a: SessionKey, b: SessionKey): boolean {
  return keyOf(a) === keyOf(b);
}

interface TxStore {
  /** Last known state per session (from `session-state` events or loads). */
  states: Record<string, SessionState | undefined>;
  init(): Promise<() => void>;
  load(session: SessionKey): Promise<SessionState>;
  setSettings(session: SessionKey, settings: TxSettings): Promise<void>;
  /** Throw the backend error (e.g. a failed commit) so dialogs can show it. */
  commit(session: SessionKey): Promise<void>;
  rollback(session: SessionKey): Promise<void>;
}

export const useTx = create<TxStore>((set) => {
  const put = (s: SessionState) =>
    set((st) => ({ states: { ...st.states, [keyOf(s.session)]: s } }));
  return {
    states: {},
    init: () => backend.onSessionState(put),
    async load(session) {
      const s = await backend.sessionState(session);
      put(s);
      return s;
    },
    async setSettings(session, settings) {
      put(await backend.sessionSetTx(session, settings));
    },
    async commit(session) {
      put(await backend.txCommit(session));
    },
    async rollback(session) {
      put(await backend.txRollback(session));
    },
  };
});

/** Open sessions with an open or failed transaction, optionally of one data source. */
export function openTransactions(sourceId?: string): SessionState[] {
  return Object.values(useTx.getState().states).filter(
    (s): s is SessionState =>
      !!s && s.open && s.status !== 'idle' && (!sourceId || s.session.sourceId === sourceId),
  );
}
