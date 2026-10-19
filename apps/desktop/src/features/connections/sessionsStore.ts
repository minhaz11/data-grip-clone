import { create } from 'zustand';
import { backend } from '../../ipc/client';
import type { AppError, ServerInfo, StatusEvent } from '../../ipc/types';
import { toAppError } from '../../lib/errors';

export type SessionState =
  | { state: 'connecting' }
  | { state: 'connected'; info: ServerInfo }
  | { state: 'failed'; error: AppError }
  | { state: 'lost'; reason: string };

interface SessionsStore {
  byId: Record<string, SessionState | undefined>;
  init(): Promise<() => void>;
  /** Resolves with the error instead of throwing, so callers can branch on `connectKind`. */
  connect(id: string, password?: string): Promise<AppError | null>;
  disconnect(id: string): Promise<void>;
  clear(id: string): void;
}

export const useSessions = create<SessionsStore>((set, get) => {
  const put = (id: string, s: SessionState | undefined) =>
    set((st) => ({ byId: { ...st.byId, [id]: s } }));

  function apply(e: StatusEvent) {
    if (e.state === 'connected') put(e.id, { state: 'connected', info: e.info });
    else if (e.state === 'lost') put(e.id, { state: 'lost', reason: e.reason });
    else put(e.id, undefined);
  }

  return {
    byId: {},
    async init() {
      const unlisten = await backend.onConnectionStatus(apply);
      const live = await backend.sessionsList();
      set({
        byId: Object.fromEntries(live.map((s) => [s.id, { state: 'connected', info: s.info }])),
      });
      return unlisten;
    },
    async connect(id, password) {
      if (get().byId[id]?.state === 'connecting') return null;
      put(id, { state: 'connecting' });
      try {
        const info = await backend.connectionConnect(id, password ?? null);
        put(id, { state: 'connected', info });
        return null;
      } catch (e) {
        const error = toAppError(e);
        put(id, { state: 'failed', error });
        return error;
      }
    },
    async disconnect(id) {
      await backend.connectionDisconnect(id);
      put(id, undefined);
    },
    clear: (id) => put(id, undefined),
  };
});
