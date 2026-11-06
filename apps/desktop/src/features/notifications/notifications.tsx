import { Bell, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';

/** One notification (REQ-ERR-08): long query finished, and later stale metadata or open transactions. */
export interface AppNotification {
  id: number;
  at: number;
  text: string;
  kind: 'info' | 'error';
  /** Shown as a toast until dismissed or timed out; stays in the list either way. */
  fresh: boolean;
}

const MAX_KEPT = 50;
/** Toasts hide after this long (the notification stays in the list). */
export const TOAST_MS = 8_000;

interface NotificationState {
  items: AppNotification[];
  notify(text: string, kind?: AppNotification['kind']): void;
  /** Hides a toast; the notification stays in the list. */
  settle(id: number): void;
  clear(): void;
}

let nextId = 1;

export const useNotifications = create<NotificationState>((set) => ({
  items: [],
  notify: (text, kind = 'info') =>
    set((s) => ({
      items: [...s.items, { id: nextId++, at: Date.now(), text, kind, fresh: true }].slice(
        -MAX_KEPT,
      ),
    })),
  settle: (id) =>
    set((s) => ({ items: s.items.map((n) => (n.id === id ? { ...n, fresh: false } : n)) })),
  clear: () => set({ items: [] }),
}));

/** Fresh notifications in the corner, announced politely to screen readers. */
export function Toasts() {
  const items = useNotifications((s) => s.items);
  const settle = useNotifications((s) => s.settle);
  const fresh = items.filter((n) => n.fresh).slice(-3);
  const ids = fresh.map((n) => `${n.id}:${n.at}`).join(',');

  useEffect(() => {
    // Each toast hides TOAST_MS after it appeared, whatever else is shown meanwhile.
    const timers = ids
      .split(',')
      .filter(Boolean)
      .map((entry) => {
        const [id, at] = entry.split(':').map(Number) as [number, number];
        return setTimeout(() => settle(id), Math.max(0, at + TOAST_MS - Date.now()));
      });
    return () => timers.forEach(clearTimeout);
  }, [ids, settle]);

  return (
    <div
      role="status"
      aria-label="Notifications"
      className="pointer-events-none fixed right-3 bottom-8 z-40 flex w-80 flex-col gap-2"
    >
      {fresh.map((n) => (
        <div
          key={n.id}
          className={`pointer-events-auto flex items-start gap-2 rounded border bg-panel px-3 py-2 text-[12px] shadow-lg ${n.kind === 'error' ? 'border-danger' : 'border-border'}`}
        >
          <span className="flex-1">{n.text}</span>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => settle(n.id)}
            className="rounded p-0.5 text-muted hover:bg-hover"
          >
            <X size={12} aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Status bar button with the notification list. */
export function NotificationButton() {
  const items = useNotifications((s) => s.items);
  const clear = useNotifications((s) => s.clear);
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Notifications (${items.length})`}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded px-1 hover:bg-hover"
      >
        <Bell size={12} aria-hidden />
        {items.length > 0 && <span className="tabular-nums">{items.length}</span>}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Notification list"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          className="absolute right-0 bottom-6 z-40 w-96 rounded border border-border bg-panel p-2 text-[12px] text-fg shadow-lg"
        >
          {items.length === 0 ? (
            <p className="text-muted">No notifications.</p>
          ) : (
            <>
              <ul className="max-h-64 space-y-1 overflow-auto">
                {[...items].reverse().map((n) => (
                  <li key={n.id} className="flex gap-2">
                    <time className="shrink-0 text-muted tabular-nums">
                      {new Date(n.at).toLocaleTimeString()}
                    </time>
                    <span className={n.kind === 'error' ? 'text-danger' : undefined}>{n.text}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={clear}
                className="mt-2 rounded border border-border px-2 py-0.5 hover:bg-hover"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}
