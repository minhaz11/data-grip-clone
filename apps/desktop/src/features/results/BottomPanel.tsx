/** Results/messages area. Result grids and execution messages arrive with Phase 3 (execution). */
export function BottomPanel() {
  return (
    <section aria-label="Results" className="flex h-full flex-col bg-panel">
      <header className="flex h-8 shrink-0 items-center border-b border-border px-3 text-[11px] font-semibold uppercase tracking-wide text-muted">
        Results
      </header>
      <div className="flex flex-1 items-center justify-center text-muted">
        No query has been run.
      </div>
    </section>
  );
}
