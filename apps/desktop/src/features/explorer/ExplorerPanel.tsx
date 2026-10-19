import { Database } from 'lucide-react';

/** Database Explorer. Data sources and the lazy schema tree arrive with Phase 2 (connections). */
export function ExplorerPanel() {
  return (
    <section aria-label="Database Explorer" className="flex h-full flex-col bg-panel">
      <header className="flex h-8 shrink-0 items-center border-b border-border px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Database Explorer
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-muted">
        <Database size={28} strokeWidth={1.5} aria-hidden />
        <p>No data sources configured.</p>
      </div>
    </section>
  );
}
