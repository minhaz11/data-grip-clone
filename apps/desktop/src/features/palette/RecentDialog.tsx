import clsx from 'clsx';
import { useId, useState } from 'react';
import { useNav } from '../../app/navStore';
import { isConsole, useWorkspace, type EditorTab } from '../../app/workspaceStore';
import { Modal } from '../../components/ui/Modal';

export function tabName(tab: EditorTab): string {
  if (isConsole(tab)) {
    return `${tab.console}.sql`;
  }
  if (tab.kind === 'data') {
    return `${tab.object.name} (data)`;
  }
  return tab.kind === 'object' ? tab.object.name : `DDL: ${tab.title}`;
}

interface Entry {
  key: string;
  label: string;
  detail: string;
  open(): void;
}

/**
 * Recent tabs, most recently used first, then recently closed consoles. The second entry is
 * selected, so Enter switches back to the previous tab (like Ctrl+Tab in an IDE).
 */
export function RecentDialog({ onClose }: { onClose(): void }) {
  const tabs = useWorkspace((s) => s.tabs);
  const closed = useWorkspace((s) => s.closed);
  const recent = useNav((s) => s.recent);
  const listId = useId();

  const byId = new Map(tabs.map((t) => [t.id, t]));
  const ordered = [
    ...recent.map((id) => byId.get(id)).filter((t): t is EditorTab => !!t),
    ...tabs.filter((t) => !recent.includes(t.id)),
  ];
  const openNames = new Set(tabs.filter(isConsole).map((t) => t.console));
  const closedConsoles = [
    ...new Set(
      closed
        .flatMap((c) => ('console' in c ? [c.console] : []))
        .reverse()
        .filter((name) => !openNames.has(name)),
    ),
  ];
  const entries: Entry[] = [
    ...ordered.map((t) => ({
      key: t.id,
      label: tabName(t),
      detail: 'open',
      open: () => useWorkspace.getState().activate(t.id),
    })),
    ...closedConsoles.map((name) => ({
      key: `closed:${name}`,
      label: `${name}.sql`,
      detail: 'closed',
      open: () => void useWorkspace.getState().openConsole(name),
    })),
  ];
  const [active, setActive] = useState(entries.length > 1 ? 1 : 0);
  const selected = entries[active];

  function choose(entry: Entry | undefined) {
    if (entry) {
      onClose();
      entry.open();
    }
  }

  return (
    <Modal title="Recent Tabs" onClose={onClose} width={420} initialFocus="[role=listbox]">
      {entries.length === 0 ? (
        <p className="text-muted">Nothing opened yet.</p>
      ) : (
        <ul
          id={listId}
          role="listbox"
          aria-label="Recent tabs"
          tabIndex={0}
          aria-activedescendant={selected ? `${listId}-${active}` : undefined}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const delta = e.key === 'ArrowDown' ? 1 : -1;
              setActive((i) => (i + delta + entries.length) % entries.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(selected);
            }
          }}
          className="max-h-80 overflow-auto rounded border border-border bg-bg py-1 outline-none"
        >
          {entries.map((entry, i) => (
            <li
              key={entry.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onClick={() => choose(entry)}
              className={clsx(
                'flex cursor-default items-center gap-2 px-2 py-1 font-mono text-[12px]',
                i === active && 'bg-selected',
              )}
            >
              <span className="min-w-0 truncate">{entry.label}</span>
              <span className="ml-auto shrink-0 font-sans text-[11px] text-muted">
                {entry.detail}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
