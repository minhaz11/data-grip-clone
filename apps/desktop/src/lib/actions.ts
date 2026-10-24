/**
 * Every keyboard-reachable action, registered once (REQ-KEY-01). Ids are stable: user overrides
 * are stored by id in settings, so renaming one drops its custom bindings.
 *
 * Bindings use "Ctrl" for the primary modifier, which is Cmd on macOS; "Control" is the physical
 * Control key there (it does not exist as a separate modifier elsewhere). Arrow keys, Page Up/Down,
 * Home and End inside lists, trees and grids, and Enter/Escape/Tab in dialogs and cell editors are
 * widget navigation, not actions, and are not rebindable.
 */

/** Where an action applies. Focused-context actions win over global ones with the same chord. */
export type ActionContext = 'global' | 'editor' | 'grid' | 'explorer';

export interface ActionDef {
  id: string;
  title: string;
  context: ActionContext;
  /** Default bindings on Windows and Linux (and macOS unless `mac` is given). */
  defaults: string[];
  /** macOS defaults where the system owns the usual chord (Cmd+Q, Cmd+Tab, Option+arrows). */
  mac?: string[];
}

export const ACTIONS = [
  // Global
  { id: 'console.new', title: 'New console', context: 'global', defaults: ['Ctrl+Shift+Q'] },
  { id: 'tab.close', title: 'Close tab', context: 'global', defaults: ['Ctrl+W', 'Ctrl+F4'] },
  {
    id: 'tab.next',
    title: 'Next tab',
    context: 'global',
    defaults: ['Ctrl+Tab', 'Alt+Right'],
    mac: ['Control+Tab', 'Ctrl+Shift+]'],
  },
  {
    id: 'tab.previous',
    title: 'Previous tab',
    context: 'global',
    defaults: ['Ctrl+Shift+Tab', 'Alt+Left'],
    mac: ['Control+Shift+Tab', 'Ctrl+Shift+['],
  },
  {
    id: 'view.toggleExplorer',
    title: 'Show or hide the Database Explorer',
    context: 'global',
    defaults: ['Alt+1'],
    mac: ['Ctrl+1'],
  },
  {
    id: 'view.toggleBottomPanel',
    title: 'Show or hide the results panel',
    context: 'global',
    defaults: ['Alt+4'],
    mac: ['Ctrl+4'],
  },
  { id: 'settings.open', title: 'Settings', context: 'global', defaults: ['Ctrl+Alt+S'] },
  {
    id: 'datasource.new',
    title: 'New data source',
    context: 'global',
    defaults: ['Alt+Insert'],
    mac: ['Ctrl+N'],
  },
  {
    id: 'query.run',
    title: 'Run statement or selection',
    context: 'global',
    defaults: ['Ctrl+Enter'],
  },
  {
    id: 'query.runScript',
    title: 'Run whole console',
    context: 'global',
    defaults: ['Ctrl+Shift+F10'],
  },
  { id: 'query.cancel', title: 'Stop the running query', context: 'global', defaults: ['Ctrl+F2'] },
  { id: 'history.open', title: 'Query history', context: 'global', defaults: ['Ctrl+Alt+E'] },
  // Editor
  { id: 'editor.format', title: 'Format SQL', context: 'editor', defaults: ['Ctrl+Alt+L'] },
  { id: 'editor.nextError', title: 'Next error', context: 'editor', defaults: ['F8'] },
  {
    id: 'editor.previousError',
    title: 'Previous error',
    context: 'editor',
    defaults: ['Shift+F8'],
  },
  // Result grid
  { id: 'grid.selectAll', title: 'Select all cells', context: 'grid', defaults: ['Ctrl+A'] },
  { id: 'grid.copy', title: 'Copy selected cells', context: 'grid', defaults: ['Ctrl+C'] },
  { id: 'grid.editCell', title: 'Edit cell', context: 'grid', defaults: ['Enter', 'F2'] },
  {
    id: 'grid.deleteRows',
    title: 'Delete selected rows',
    context: 'grid',
    defaults: ['Delete'],
    mac: ['Delete', 'Ctrl+Backspace'],
  },
  { id: 'grid.addRow', title: 'Add row', context: 'grid', defaults: ['Insert'], mac: ['Ctrl+I'] },
  {
    id: 'grid.columnMenu',
    title: 'Column menu',
    context: 'grid',
    defaults: ['Shift+F10', 'ContextMenu'],
  },
  // Database Explorer
  {
    id: 'explorer.quickInfo',
    title: 'Quick info',
    context: 'explorer',
    defaults: ['Ctrl+Q'],
    mac: ['Control+Q'],
  },
  { id: 'explorer.refresh', title: 'Refresh', context: 'explorer', defaults: ['Ctrl+F5'] },
  {
    id: 'explorer.delete',
    title: 'Delete data source',
    context: 'explorer',
    defaults: ['Delete'],
    mac: ['Delete', 'Ctrl+Backspace'],
  },
  {
    id: 'explorer.duplicate',
    title: 'Duplicate data source',
    context: 'explorer',
    defaults: ['Ctrl+D'],
  },
  {
    id: 'explorer.contextMenu',
    title: 'Context menu',
    context: 'explorer',
    defaults: ['Shift+F10', 'ContextMenu'],
  },
  {
    id: 'explorer.rename',
    title: 'Rename data source or folder',
    context: 'explorer',
    defaults: ['Shift+F6', 'F2'],
  },
  {
    id: 'explorer.moveUp',
    title: 'Move data source up',
    context: 'explorer',
    defaults: ['Alt+Shift+Up'],
  },
  {
    id: 'explorer.moveDown',
    title: 'Move data source down',
    context: 'explorer',
    defaults: ['Alt+Shift+Down'],
  },
] as const satisfies readonly ActionDef[];

export type ActionId = (typeof ACTIONS)[number]['id'];

export const CONTEXT_LABELS: Record<ActionContext, string> = {
  global: 'Everywhere',
  editor: 'SQL editor',
  grid: 'Result grid',
  explorer: 'Database Explorer',
};

const BY_ID = new Map<string, ActionDef>(ACTIONS.map((a) => [a.id, a]));

export function actionDef(id: ActionId): ActionDef {
  const def = BY_ID.get(id);
  if (!def) {
    throw new Error(`unknown action ${id}`);
  }
  return def;
}

export function isActionId(id: string): id is ActionId {
  return BY_ID.has(id);
}
