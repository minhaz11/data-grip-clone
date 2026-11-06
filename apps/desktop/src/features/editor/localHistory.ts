import { isConsole, useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { RevisionReason } from '../../ipc/types';
import { activeEditor } from './editorHandle';

/**
 * Keeps the active console's text in its local history (after saving pending edits). Never
 * blocks the action it precedes: a failure only means no revision.
 */
export async function checkpoint(reason: RevisionReason): Promise<void> {
  const ws = useWorkspace.getState();
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
  if (!isConsole(tab)) {
    return;
  }
  try {
    await ws.flushAll();
    await backend.consoleCheckpoint(tab.console, reason);
  } catch {
    // Saving reports its own errors in the tab.
  }
}

/** Formats the active console, keeping the text before it in the local history. */
export async function formatWithHistory(): Promise<void> {
  await checkpoint('beforeFormat');
  activeEditor()?.format();
}
