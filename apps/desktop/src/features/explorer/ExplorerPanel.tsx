import {
  ChevronsDownUp,
  ChevronsUpDown,
  Database,
  FolderPlus,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ContextMenu, type MenuItem } from '../../components/ui/ContextMenu';
import { IconButton } from '../../components/ui/IconButton';
import type { AppError, ConnectionProfile } from '../../ipc/types';
import { useContextActions, useKeymap } from '../../app/keymapStore';
import { shortcutLabel } from '../../lib/keymap';
import { ConnectFailure } from '../connections/ConnectFailure';
import { useConnections } from '../connections/connectionsStore';
import { FolderDialog, MoveDialog } from '../connections/FolderDialogs';
import { scopeLabel } from '../connections/model';
import { connectSource } from '../connections/connectFlow';
import { useSessions } from '../connections/sessionsStore';
import { resetCatalog } from '../editor/catalog';
import { disconnectSource, resolveTransactions } from '../exec/txGuards';
import { openTransactions } from '../exec/txStore';
import { useMetadata } from './metadataStore';
import { TreeRow } from './TreeRow';
import { TypeFilter } from './TypeFilter';
import { useNotifications } from '../notifications/notifications';
import { flattenTree, folderKey, ROOT_REQUEST, SEP, type Row } from './treeModel';
import { useWorkspace } from '../../app/workspaceStore';
import type {
  ConnectionProfile as Profile,
  DdlObject,
  DropObject,
  Folder,
  MetaKind,
  ObjectRef,
  RenameObject,
  TableName,
} from '../../ipc/types';
import { DropDialog, RenameDialog, TruncateDialog } from '../schema/SchemaDialogs';
import { TableDialog } from '../schema/TableDialog';
import { backend } from '../../ipc/client';
import { toAppError } from '../../lib/errors';
import { QuickInfo, type QuickInfoTarget } from '../schema/QuickInfo';

interface Props {
  onNew(): void;
  onEdit(profile: ConnectionProfile): void;
}

/** Database Explorer: data sources and their lazily loaded schema tree. */
export function ExplorerPanel({ onNew, onEdit }: Props) {
  const keymap = useKeymap();
  const items = useConnections((s) => s.items);
  const folders = useConnections((s) => s.folders);
  const selectedSourceId = useConnections((s) => s.selectedId);
  const selectSource = useConnections((s) => s.select);
  const duplicate = useConnections((s) => s.duplicate);
  const remove = useConnections((s) => s.remove);
  const loadError = useConnections((s) => s.error);
  const sessions = useSessions((s) => s.byId);
  const { children, expanded, setExpanded, load, refresh, resetSource } = useMetadata();
  const schemaTotals = useMetadata((s) => s.schemaTotals);
  const loadSchemaTotal = useMetadata((s) => s.loadSchemaTotal);
  const refreshedAt = useMetadata((s) => s.refreshedAt);
  const reveal = useMetadata((s) => s.reveal);
  /** Object kinds the type filter hides. */
  const [hiddenKinds, setHiddenKinds] = useState<Set<MetaKind>>(new Set());
  /** Rows chosen for bulk actions (Ctrl/Shift+click, Shift+arrows), besides the current row. */
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);

  const [filter, setFilter] = useState('');
  const [pickedKey, setSelectedKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: Row } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConnectionProfile | null>(null);
  // Deleting disconnects: open transactions are resolved first.
  const askDelete = async (p: ConnectionProfile) => {
    if (await resolveTransactions(openTransactions(p.id), `Delete ${p.name}?`)) {
      setPendingDelete(p);
    }
  };
  const [actionError, setActionError] = useState<string | null>(null);
  const [quickInfo, setQuickInfo] = useState<QuickInfoTarget | null>(null);
  const [tool, setTool] = useState<SchemaTool | null>(null);
  const stale = useMetadata((s) => s.stale);
  const [connectError, setConnectError] = useState<{ profile: Profile; error: AppError } | null>(
    null,
  );
  /** Key of the row whose name is being edited inline. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [folderTool, setFolderTool] = useState<
    | { kind: 'edit'; folder: Folder }
    | { kind: 'delete'; folder: Folder }
    | { kind: 'move'; profile: Profile }
    | null
  >(null);
  const treeRef = useRef<HTMLUListElement>(null);
  const moveSource = useConnections((s) => s.move);

  const rows = useMemo(
    () => flattenTree(items, children, expanded, filter, folders, hiddenKinds),
    [items, children, expanded, filter, folders, hiddenKinds],
  );
  // The picked row wins while it is a folder or belongs to the selected data source; when the
  // source selection changes elsewhere (e.g. a just-created or duplicated source), that source's
  // row is selected.
  const picked = rows.find((r) => r.key === pickedKey);
  const selectedKey =
    picked && (picked.type === 'folder' || picked.profile.id === selectedSourceId)
      ? pickedKey
      : selectedSourceId;
  const selectedIndex = rows.findIndex((r) => r.key === selectedKey);
  const selected = selectedIndex >= 0 ? rows[selectedIndex] : undefined;

  // Expanded levels that were never requested load as soon as they become visible.
  useEffect(() => {
    for (const r of rows)
      if (r.type === 'status' && r.needsLoad) void load(r.parentKey, r.profile.id, r.needsLoad);
  }, [rows, load]);

  // A data source with a schema scope shows "N of M schemas": load its (scoped) schema list and
  // the total once connected. Both are dropped with the tree when the session ends.
  useEffect(() => {
    for (const p of items) {
      const scoped = p.schemaNames.length > 0 || p.schemaPattern.trim() !== '';
      if (scoped && sessions[p.id]?.state === 'connected') {
        void load(p.id, p.id, ROOT_REQUEST);
        void loadSchemaTotal(p.id);
      }
    }
  }, [items, sessions, children, load, loadSchemaTotal]);

  function scopeOf(p: Profile): string | null {
    const loaded = children[p.id];
    const shown = loaded?.status === 'loaded' ? loaded.nodes.length : null;
    return scopeLabel(p, shown, schemaTotals[p.id] ?? null);
  }

  // A source's tree is only valid while its session is: drop it on disconnect or loss.
  useEffect(() => {
    for (const p of items) {
      const loadedOrOpen = children[p.id] !== undefined || expanded[p.id];
      if (
        loadedOrOpen &&
        sessions[p.id]?.state !== 'connected' &&
        sessions[p.id]?.state !== 'connecting'
      ) {
        resetSource(p.id);
      }
    }
  }, [sessions, items, children, expanded, resetSource]);

  useEffect(() => {
    treeRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedKey]);

  /**
   * Makes `row` the current row. `extend` marks every row from the anchor to it (Shift);
   * `toggle` adds or removes it from the marked rows (Ctrl/Cmd); otherwise marks are cleared.
   */
  function select(row: Row | undefined, how: 'replace' | 'extend' | 'toggle' = 'replace') {
    if (!row) {
      return;
    }
    if (how === 'extend') {
      const from = rows.findIndex((r) => r.key === (anchor ?? selectedKey));
      const to = rows.findIndex((r) => r.key === row.key);
      const [a, b] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
      setMarked(new Set(rows.slice(a, b + 1).map((r) => r.key)));
      if (anchor === null) {
        setAnchor(selectedKey);
      }
    } else if (how === 'toggle') {
      const next = new Set(marked.size === 0 && selectedKey ? [selectedKey] : marked);
      const removed = next.delete(row.key);
      if (!removed) {
        next.add(row.key);
      }
      setMarked(next);
      setAnchor(row.key);
      // Toggling a row off keeps the current row on one that is still marked.
      const keep = removed ? [...next].pop() : undefined;
      if (keep !== undefined) {
        setSelectedKey(keep);
        return;
      }
    } else {
      setMarked(new Set());
      setAnchor(row.key);
    }
    setSelectedKey(row.key);
    if (row.type !== 'folder' && row.profile.id !== selectedSourceId) {
      selectSource(row.profile.id);
    }
  }

  /** Marked node rows of the same data source as `row` (for bulk actions), in tree order. */
  function bulkNodes(row: Row): Row[] {
    if (row.type === 'folder' || !marked.has(row.key)) {
      return [];
    }
    return rows.filter(
      (r) => marked.has(r.key) && r.type === 'node' && r.profile.id === row.profile.id,
    );
  }

  // Reveal a node asked for elsewhere (palette, editor, tabs): expand the way and select it.
  useEffect(() => {
    if (!reveal) {
      return;
    }
    const { sourceId, path } = reveal;
    const target = path[path.length - 1];
    const found = rows.find((r) => r.key === target);
    if (found) {
      // After this render: selecting is a state change of its own.
      const timer = setTimeout(() => {
        useMetadata.getState().clearReveal();
        // Focus first: focusing an unselected tree selects its first row.
        treeRef.current?.focus();
        select(found);
      }, 0);
      return () => clearTimeout(timer);
    }
    const profile = items.find((p) => p.id === sourceId);
    if (!profile) {
      useMetadata.getState().clearReveal();
      return;
    }
    if (sessions[sourceId]?.state !== 'connected') {
      if (sessions[sourceId]?.state !== 'connecting') {
        void runConnect(profile).then((ok) => {
          if (!ok) {
            useMetadata.getState().clearReveal();
          }
        });
      }
      return;
    }
    // Expand each level on the way; a loaded level without the next key ends the search.
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i] ?? '';
      const next = path[i + 1] ?? '';
      if (!expanded[key]) {
        setExpanded(key, true);
        return;
      }
      const loaded = children[key];
      if (
        loaded?.status === 'loaded' &&
        !loaded.nodes.some((n) => `${key}${SEP}${n.key}` === next)
      ) {
        useMetadata.getState().clearReveal();
        useNotifications
          .getState()
          .notify(
            'The object is not in the explorer: it may be outside the schema scope or hidden by the type filter.',
          );
        return;
      }
      if (loaded?.status === 'error') {
        useMetadata.getState().clearReveal();
        return;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run as the tree loads
  }, [reveal, rows, sessions, expanded, children]);

  async function commitRename(row: Row, name: string | null) {
    setRenaming(null);
    treeRef.current?.focus();
    if (name === null) {
      return;
    }
    setActionError(null);
    try {
      if (row.type === 'folder') {
        await useConnections.getState().updateFolder(row.folder.id, name, row.folder.color);
      } else if (row.type === 'source') {
        await useConnections.getState().rename(row.profile.id, name);
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  /** The folder a data source shows in (`null` at the top level, also when its folder is gone). */
  function folderOf(p: Profile): string | null {
    return p.folderId && folders.some((f) => f.id === p.folderId) ? p.folderId : null;
  }

  /** Data sources in the same folder as `p`, in explorer order. */
  function siblingsOf(p: Profile): Profile[] {
    return items.filter((c) => folderOf(c) === folderOf(p));
  }

  async function runMove(id: string, folderId: string | null, index: number) {
    setActionError(null);
    try {
      await moveSource(id, folderId, index);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Moves a data source one place up or down within its folder. */
  function step(p: Profile, by: -1 | 1) {
    const siblings = siblingsOf(p);
    const index = siblings.findIndex((c) => c.id === p.id) + by;
    if (index >= 0 && index < siblings.length) {
      void runMove(p.id, folderOf(p), index);
    }
  }

  /** Drops the dragged data source on `target`: into a folder (last), or before a data source. */
  function dropOn(target: Row | null) {
    const id = dragged;
    setDragged(null);
    if (!id) {
      return;
    }
    if (target === null) {
      void runMove(id, null, items.length);
    } else if (target.type === 'folder') {
      void runMove(id, target.folder.id, items.length);
    } else if (target.type === 'source' && target.profile.id !== id) {
      const siblings = siblingsOf(target.profile).filter((c) => c.id !== id);
      const index = siblings.findIndex((c) => c.id === target.profile.id);
      void runMove(id, folderOf(target.profile), Math.max(0, index));
    }
  }

  async function newFolder() {
    setActionError(null);
    const taken = new Set(folders.map((f) => f.name.toLowerCase()));
    let name = 'New Folder';
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      name = `New Folder ${n}`;
    }
    try {
      const folder = await useConnections.getState().createFolder(name, null);
      setSelectedKey(folderKey(folder.id));
      setRenaming(folderKey(folder.id));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runConnect(p: ConnectionProfile): Promise<boolean> {
    setConnectError(null);
    const outcome = await connectSource(p);
    if (!outcome.ok && outcome.error) {
      setConnectError({ profile: p, error: outcome.error });
    }
    return outcome.ok;
  }

  async function runDuplicate(p: ConnectionProfile) {
    setActionError(null);
    try {
      await duplicate(p.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Expands or collapses a row; expanding a disconnected data source connects first. */
  async function toggle(row: Row, open = !isOpen(row)) {
    if (row.type === 'status') return;
    if (row.type === 'node' && !row.node.children) return;
    if (row.type === 'folder') {
      setExpanded(row.key, open);
      return;
    }
    if (open && row.type === 'source' && sessions[row.profile.id]?.state !== 'connected') {
      if (!(await runConnect(row.profile))) return;
    }
    setExpanded(row.key, open);
  }

  function isOpen(row: Row) {
    return row.type !== 'status' && row.expanded;
  }

  /** Reloads everything loaded below a data source (catalog for completion too). */
  function forceRefresh(row: Row) {
    if (row.type === 'folder' || sessions[row.profile.id]?.state !== 'connected') {
      return;
    }
    refresh(row.profile.id);
    resetCatalog(row.profile.id);
  }

  function refreshRow(row: Row) {
    if (row.type === 'status' || row.type === 'folder') return;
    if (row.type === 'source' && sessions[row.profile.id]?.state !== 'connected') return;
    refresh(row.key);
    resetCatalog(row.profile.id); // completion re-reads the catalog too
  }

  /** The table, view or materialized view a node stands for, if it is one. */
  function objectOf(row: Row | undefined): ObjectRef | null {
    if (row?.type !== 'node' || row.node.children?.level !== 'objectGroups') {
      return null;
    }
    const { schema, name, objectType } = row.node.children;
    return { schema, name, objectType };
  }

  /** What Quick info shows for a row: a table-like object, or a column with its table. */
  function quickInfoOf(row: Row | undefined): QuickInfoTarget | null {
    if (row?.type !== 'node') {
      return null;
    }
    const object = objectOf(row);
    if (object) {
      return { sourceId: row.profile.id, object };
    }
    if (row.node.kind === 'column') {
      // A column's parent is its table's "Columns" group.
      const tableKey = row.parentKey.slice(0, row.parentKey.lastIndexOf(SEP));
      const table = objectOf(rows.find((r) => r.key === tableKey));
      return table ? { sourceId: row.profile.id, object: table, column: row.node.name } : null;
    }
    return null;
  }

  /** What "Show DDL" generates for a row, and a title for it. */
  function ddlOf(row: Row): { object: DdlObject; title: string } | null {
    if (row.type !== 'node') {
      return null;
    }
    const n = row.node;
    if (n.kind === 'schema') {
      return { object: { kind: 'schema', schema: n.name }, title: n.name };
    }
    const object = objectOf(row);
    if (object) {
      return {
        object: { kind: 'relation', schema: object.schema, name: object.name },
        title: `${object.schema}.${object.name}`,
      };
    }
    // Routines, sequences, indexes and triggers take their schema (and table) from the group
    // they are listed in.
    const parent = rows.find((r) => r.key === row.parentKey);
    const from = parent?.type === 'node' ? parent.node.children : undefined;
    if (!from) {
      return null;
    }
    if (n.kind === 'routine' && from.level === 'routines') {
      const args = n.key.slice(`r:${n.name}(`.length, -1);
      return {
        object: { kind: 'routine', schema: from.schema, name: n.name, args },
        title: `${from.schema}.${n.name}(${args})`,
      };
    }
    if (n.kind === 'sequence' && from.level === 'sequences') {
      return {
        object: { kind: 'sequence', schema: from.schema, name: n.name },
        title: `${from.schema}.${n.name}`,
      };
    }
    if (n.kind === 'index' && from.level === 'indexes') {
      return {
        object: { kind: 'index', schema: from.schema, name: n.name },
        title: `${from.schema}.${n.name}`,
      };
    }
    if (n.kind === 'trigger' && from.level === 'triggers') {
      return {
        object: { kind: 'trigger', schema: from.schema, table: from.table, name: n.name },
        title: `${n.name} on ${from.schema}.${from.table}`,
      };
    }
    return null;
  }

  async function copyDdls(sourceId: string, objects: DdlObject[]) {
    try {
      const script = await backend.ddlGenerate(sourceId, objects, {
        qualify: true,
        owner: false,
        grants: false,
      });
      await navigator.clipboard?.writeText(script);
    } catch (e) {
      setActionError(toAppError(e).message);
    }
  }

  /** Show DDL for the marked rows, or the current one. */
  function goToDdl(row: Row) {
    const bulk = bulkNodes(row);
    const targets = (bulk.length > 1 ? bulk : [row])
      .map((r) => ddlOf(r))
      .filter((d): d is NonNullable<typeof d> => d !== null);
    if (row.type === 'folder' || targets.length === 0) {
      return;
    }
    const first = targets[0];
    void useWorkspace.getState().openDdl(
      row.profile.id,
      targets.map((d) => d.object),
      targets.length === 1 && first ? first.title : `${targets.length} objects`,
    );
  }

  async function copyDdl(row: Row, target: { object: DdlObject }) {
    if (row.type === 'folder') {
      return;
    }
    try {
      const script = await backend.ddlGenerate(row.profile.id, [target.object], {
        qualify: true,
        owner: false,
        grants: false,
      });
      await navigator.clipboard?.writeText(script);
    } catch (e) {
      setActionError(toAppError(e).message);
    }
  }

  /** Refreshes what a schema change can affect: the schema's subtree (or the whole source). */
  function afterChange(sourceId: string, schema: string | null) {
    refresh(schema === null ? sourceId : `${sourceId}${SEP}s:${schema}`);
    resetCatalog(sourceId);
  }

  /** Create/modify/drop/truncate/rename actions for a node (M4.5). */
  function schemaTools(row: Row): MenuItem[] {
    if (row.type !== 'node' || row.profile.readOnly) {
      return [];
    }
    const source = row.profile;
    const n = row.node;
    const parent = rows.find((r) => r.key === row.parentKey);
    const from = parent?.type === 'node' ? parent.node.children : undefined;
    const drop = (objects: DropObject[], label: string): MenuItem => ({
      label: 'Drop…',
      danger: true,
      onSelect: () => setTool({ kind: 'drop', source, objects, label }),
    });
    const rename = (object: RenameObject, current: string): MenuItem => ({
      label: 'Rename…',
      onSelect: () => setTool({ kind: 'rename', source, object, current }),
    });
    const newTable = (schema: string): MenuItem => ({
      label: 'New table…',
      onSelect: () => setTool({ kind: 'table', source, schema }),
    });
    if (n.kind === 'schema') {
      return [
        newTable(n.name),
        rename({ kind: 'schema', schema: n.name }, n.name),
        drop([{ kind: 'schema', schema: n.name }], `schema ${n.name}`),
      ];
    }
    if (n.kind === 'group' && n.children?.level === 'objects' && n.key === 'g:tables') {
      return [newTable(n.children.schema)];
    }
    const object = objectOf(row);
    if (object) {
      const { schema, name, objectType } = object;
      const label = `${objectType.replace('_', ' ')} ${schema}.${name}`;
      const items: MenuItem[] = [];
      if (objectType === 'table') {
        items.push({
          label: 'Modify table…',
          onSelect: () => setTool({ kind: 'table', source, schema, table: name }),
        });
      }
      items.push(rename({ kind: 'relation', schema, name, objectType }, name));
      if (objectType === 'table') {
        items.push({
          label: 'Truncate…',
          danger: true,
          onSelect: () => setTool({ kind: 'truncate', source, tables: [{ schema, name }] }),
        });
      }
      items.push(drop([{ kind: 'relation', schema, name, objectType }], label));
      return items;
    }
    if (n.kind === 'column' && from?.level === 'columns') {
      return [
        rename({ kind: 'column', schema: from.schema, table: from.table, name: n.name }, n.name),
      ];
    }
    if (n.kind === 'sequence' && from?.level === 'sequences') {
      return [
        drop(
          [{ kind: 'sequence', schema: from.schema, name: n.name }],
          `sequence ${from.schema}.${n.name}`,
        ),
      ];
    }
    if (n.kind === 'index' && from?.level === 'indexes') {
      return [
        drop(
          [{ kind: 'index', schema: from.schema, name: n.name }],
          `index ${from.schema}.${n.name}`,
        ),
      ];
    }
    if (n.kind === 'trigger' && from?.level === 'triggers') {
      return [
        drop(
          [{ kind: 'trigger', schema: from.schema, table: from.table, name: n.name }],
          `trigger ${n.name}`,
        ),
      ];
    }
    if (n.kind === 'routine' && from?.level === 'routines') {
      const args = n.key.slice(`r:${n.name}(`.length, -1);
      const procedure = n.flags?.includes('procedure') ?? false;
      return [
        drop(
          [{ kind: 'routine', schema: from.schema, name: n.name, args, procedure }],
          `${procedure ? 'procedure' : 'function'} ${from.schema}.${n.name}`,
        ),
      ];
    }
    return [];
  }

  function openViewer(row: Row): boolean {
    const object = objectOf(row);
    if (!object || row.type === 'folder') {
      return false;
    }
    useWorkspace.getState().openObject(row.profile.id, object);
    return true;
  }

  function openData(row: Row) {
    const object = objectOf(row);
    if (object && row.type !== 'folder') {
      useWorkspace.getState().openData(row.profile.id, object);
    }
  }

  function menuItems(row: Row): MenuItem[] {
    if (row.type === 'folder') {
      return [
        {
          label: 'Rename',
          shortcut: shortcutLabel('explorer.rename', keymap),
          onSelect: () => setRenaming(row.key),
        },
        {
          label: 'Properties…',
          onSelect: () => setFolderTool({ kind: 'edit', folder: row.folder }),
        },
        {
          label: 'Delete folder…',
          danger: true,
          onSelect: () => setFolderTool({ kind: 'delete', folder: row.folder }),
        },
      ];
    }
    const refreshItem: MenuItem = {
      label: 'Refresh',
      shortcut: shortcutLabel('explorer.refresh', keymap),
      onSelect: () => refreshRow(row),
    };
    const bulk = bulkNodes(row);
    if (bulk.length > 1) {
      const ddls = bulk.map((r) => ddlOf(r)).filter((d): d is NonNullable<typeof d> => d !== null);
      const sourceId = row.profile.id;
      const names = bulk.map((r) => (r.type === 'node' ? r.node.name : ''));
      return [
        ...(ddls.length > 0
          ? [
              {
                label: `Show DDL of ${ddls.length} objects`,
                shortcut: shortcutLabel('explorer.goToDdl', keymap),
                onSelect: () =>
                  void useWorkspace.getState().openDdl(
                    sourceId,
                    ddls.map((d) => d.object),
                    `${ddls.length} objects`,
                  ),
              },
              {
                label: `Copy DDL of ${ddls.length} objects`,
                onSelect: () =>
                  void copyDdls(
                    sourceId,
                    ddls.map((d) => d.object),
                  ),
              },
            ]
          : []),
        {
          label: `Copy ${names.length} names`,
          onSelect: () => void navigator.clipboard?.writeText(names.join('\n')),
        },
      ];
    }
    if (row.type === 'node') {
      const info = quickInfoOf(row);
      const ddl = ddlOf(row);
      const live = sessions[row.profile.id]?.state === 'connected';
      return [
        ...(objectOf(row)
          ? [
              { label: 'Open table viewer', shortcut: 'Enter', onSelect: () => openViewer(row) },
              { label: 'Open data', onSelect: () => openData(row) },
            ]
          : []),
        ...(info
          ? [
              {
                label: 'Quick info',
                shortcut: shortcutLabel('explorer.quickInfo', keymap),
                onSelect: () => setQuickInfo(info),
              },
            ]
          : []),
        ...(ddl && live
          ? [
              {
                label: 'Show DDL',
                shortcut: shortcutLabel('explorer.goToDdl', keymap),
                onSelect: () =>
                  void useWorkspace.getState().openDdl(row.profile.id, [ddl.object], ddl.title),
              },
              { label: 'Copy DDL', onSelect: () => void copyDdl(row, ddl) },
            ]
          : []),
        ...(live ? schemaTools(row) : []),
        refreshItem,
        { label: 'Copy name', onSelect: () => void navigator.clipboard?.writeText(row.node.name) },
      ];
    }
    const p = row.profile;
    const state = sessions[p.id]?.state;
    const live = state === 'connected' || state === 'connecting';
    return [
      live
        ? { label: 'Disconnect', onSelect: () => void disconnectSource(p.id) }
        : { label: 'Connect', onSelect: () => void runConnect(p) },
      ...(state === 'connected'
        ? [
            refreshItem,
            {
              label: 'Force refresh',
              shortcut: shortcutLabel('explorer.forceRefresh', keymap),
              onSelect: () => forceRefresh(row),
            },
          ]
        : []),
      { label: 'Properties…', shortcut: 'Enter', onSelect: () => onEdit(p) },
      {
        label: 'Rename',
        shortcut: shortcutLabel('explorer.rename', keymap),
        onSelect: () => setRenaming(p.id),
      },
      { label: 'Move to folder…', onSelect: () => setFolderTool({ kind: 'move', profile: p }) },
      {
        label: 'Move up',
        shortcut: shortcutLabel('explorer.moveUp', keymap),
        onSelect: () => step(p, -1),
      },
      {
        label: 'Move down',
        shortcut: shortcutLabel('explorer.moveDown', keymap),
        onSelect: () => step(p, 1),
      },
      {
        label: 'Duplicate',
        shortcut: shortcutLabel('explorer.duplicate', keymap),
        onSelect: () => void runDuplicate(p),
      },
      {
        label: 'Delete…',
        shortcut: shortcutLabel('explorer.delete', keymap),
        danger: true,
        onSelect: () => void askDelete(p),
      },
    ];
  }

  const current = selected;
  const source = current?.type === 'source' ? current.profile : null;
  const runAction = useContextActions('explorer', {
    'explorer.quickInfo': current
      ? () => {
          const info = quickInfoOf(current);
          if (info) {
            setQuickInfo(info);
          }
        }
      : undefined,
    'explorer.refresh': current ? () => refreshRow(current) : undefined,
    'explorer.delete': source ? () => void askDelete(source) : undefined,
    'explorer.duplicate': source ? () => void runDuplicate(source) : undefined,
    'explorer.rename':
      current?.type === 'source' || current?.type === 'folder'
        ? () => setRenaming(current.key)
        : undefined,
    'explorer.moveUp': source ? () => step(source, -1) : undefined,
    'explorer.moveDown': source ? () => step(source, 1) : undefined,
    'explorer.goToDdl': current ? () => goToDdl(current) : undefined,
    'explorer.forceRefresh': current ? () => forceRefresh(current) : undefined,
    'explorer.collapseAll': () =>
      useMetadata.getState().collapseAll(folders.map((f) => folderKey(f.id))),
    'explorer.expandAll':
      current && current.type !== 'status'
        ? () => useMetadata.getState().expandLoaded(current.key)
        : undefined,
    'explorer.contextMenu': current
      ? () => {
          const rect = treeRef.current
            ?.querySelector('[aria-selected="true"]')
            ?.getBoundingClientRect();
          setMenu({ x: (rect?.left ?? 0) + 24, y: rect?.bottom ?? 0, row: current });
        }
      : undefined,
  });

  function onTreeKeyDown(e: React.KeyboardEvent) {
    if (runAction(e)) {
      return;
    }
    // Tree navigation (WAI-ARIA tree pattern, not rebindable).
    const move = (i: number) =>
      select(rows[Math.max(0, Math.min(rows.length - 1, i))], e.shiftKey ? 'extend' : 'replace');
    const row = selected;
    if (e.key === 'ArrowDown') move(selectedIndex + 1);
    else if (e.key === 'ArrowUp') move(selectedIndex < 0 ? 0 : selectedIndex - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(rows.length - 1);
    else if (!row) return;
    else if (e.key === 'ArrowRight') {
      if (row.type !== 'status' && !row.expanded) void toggle(row, true);
      else if (rows[selectedIndex + 1]?.level === row.level + 1) move(selectedIndex + 1);
    } else if (e.key === 'ArrowLeft') {
      if (row.type !== 'status' && row.expanded) void toggle(row, false);
      else if (row.type !== 'folder' && row.parentKey !== null)
        select(rows.find((r) => r.key === row.parentKey));
    } else if (e.key === 'Enter') {
      if (row.type === 'source') onEdit(row.profile);
      else if (row.type === 'folder') void toggle(row);
      else if (!openViewer(row)) void toggle(row);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <section aria-label="Database Explorer" className="flex h-full flex-col bg-panel">
      <header className="flex h-8 shrink-0 items-center border-b border-border pl-3 pr-1">
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
          Database Explorer
        </h2>
        <TypeFilter hidden={hiddenKinds} onChange={setHiddenKinds} />
        <IconButton
          label="Collapse all"
          shortcut={shortcutLabel('explorer.collapseAll', keymap)}
          onClick={() => useMetadata.getState().collapseAll(folders.map((f) => folderKey(f.id)))}
        >
          <ChevronsDownUp size={14} aria-hidden />
        </IconButton>
        <IconButton
          label="Expand all loaded below the selection"
          shortcut={shortcutLabel('explorer.expandAll', keymap)}
          onClick={() =>
            selected && selected.type !== 'status'
              ? useMetadata.getState().expandLoaded(selected.key)
              : undefined
          }
        >
          <ChevronsUpDown size={14} aria-hidden />
        </IconButton>
        <IconButton label="New folder" onClick={() => void newFolder()}>
          <FolderPlus size={15} aria-hidden />
        </IconButton>
        <IconButton
          label="New data source"
          shortcut={shortcutLabel('datasource.new', keymap)}
          onClick={onNew}
        >
          <Plus size={15} aria-hidden />
        </IconButton>
      </header>

      {items.length > 0 && (
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1">
          <Search size={13} className="shrink-0 text-muted" aria-hidden />
          <input
            type="search"
            aria-label="Filter loaded objects"
            placeholder="Filter loaded objects"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.stopPropagation();
                setFilter('');
              } else if ((e.key === 'Enter' || e.key === 'F3') && filter.trim()) {
                // Next (or with Shift previous) row whose name matches, wrapping around.
                e.preventDefault();
                const needle = filter.trim().toLowerCase();
                const nameOf = (r: Row) =>
                  r.type === 'node'
                    ? r.node.name
                    : r.type === 'folder'
                      ? r.folder.name
                      : r.type === 'source'
                        ? r.profile.name
                        : '';
                const step = e.shiftKey ? -1 : 1;
                for (let i = 1; i <= rows.length; i++) {
                  const r = rows[(selectedIndex + step * i + rows.length * 2) % rows.length];
                  if (r && nameOf(r).toLowerCase().includes(needle)) {
                    select(r);
                    break;
                  }
                }
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                treeRef.current?.focus();
                if (!selected) select(rows[0]);
              }
            }}
            className="min-w-0 flex-1 bg-transparent py-0.5 outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
          />
          {filter && (
            <button
              type="button"
              aria-label="Clear filter"
              onClick={() => setFilter('')}
              className="rounded p-0.5 text-muted hover:bg-hover"
            >
              <X size={12} aria-hidden />
            </button>
          )}
        </div>
      )}

      {connectError && (
        <ConnectFailure
          profile={connectError.profile}
          error={connectError.error}
          onEdit={() => onEdit(connectError.profile)}
          onConnect={() => void runConnect(connectError.profile)}
          onDismiss={() => setConnectError(null)}
        />
      )}

      {(loadError || actionError) && (
        <p role="alert" className="border-b border-border px-3 py-1.5 text-danger">
          {actionError ?? loadError}
        </p>
      )}

      {items
        .filter((p) => stale[p.id] && sessions[p.id]?.state === 'connected')
        .map((p) => (
          <div
            key={p.id}
            role="status"
            className="flex items-center gap-2 border-b border-border bg-panel-2 px-3 py-1.5"
          >
            <span className="min-w-0 flex-1">
              {p.name} may be out of date: schema statements ran in a console.
            </span>
            <button
              type="button"
              className="shrink-0 text-accent underline"
              onClick={() => afterChange(p.id, null)}
            >
              Refresh
            </button>
          </div>
        ))}

      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center text-muted">
          <Database size={28} strokeWidth={1.5} aria-hidden />
          <p>No data sources configured.</p>
          <button
            type="button"
            onClick={onNew}
            className="rounded border border-border px-3 py-1 text-fg hover:bg-hover"
          >
            New data source{' '}
            <span className="text-muted">({shortcutLabel('datasource.new', keymap)})</span>
          </button>
        </div>
      ) : (
        <ul
          ref={treeRef}
          role="tree"
          aria-label="Data sources"
          aria-multiselectable
          tabIndex={0}
          aria-activedescendant={selected ? `tree-row-${selectedIndex}` : undefined}
          onKeyDown={onTreeKeyDown}
          data-action-context="explorer"
          onFocus={() => !selected && select(rows[0])}
          // Dropping a data source below the last row moves it to the top level.
          onDragOver={(e) => {
            if (dragged) {
              e.preventDefault();
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            dropOn(null);
          }}
          className="@container flex-1 overflow-auto py-1 outline-none"
        >
          {rows.map((row, i) => (
            <TreeRow
              key={row.key}
              id={`tree-row-${i}`}
              row={row}
              selected={row.key === selectedKey || marked.has(row.key)}
              session={row.type === 'folder' ? undefined : sessions[row.profile.id]}
              highlight={filter.trim()}
              onSelect={(e) =>
                select(
                  row,
                  e?.shiftKey ? 'extend' : e && (e.ctrlKey || e.metaKey) ? 'toggle' : 'replace',
                )
              }
              onToggle={() => void toggle(row)}
              onActivate={() => {
                if (row.type === 'source') onEdit(row.profile);
                else if (row.type === 'folder' || !openViewer(row)) void toggle(row);
              }}
              onContextMenu={(x, y) => {
                // A right-click inside the marked rows keeps them for a bulk action.
                if (!marked.has(row.key)) {
                  select(row);
                }
                if (row.type !== 'status') setMenu({ x, y, row });
              }}
              onRetry={() => row.type === 'status' && refresh(row.parentKey)}
              onCancel={() =>
                row.type === 'status' &&
                void useMetadata.getState().cancelLoad(row.parentKey, row.profile.id)
              }
              refreshedAt={row.type === 'source' ? refreshedAt[row.profile.id] : undefined}
              renaming={renaming === row.key}
              onRename={(name) => void commitRename(row, name)}
              scopeLabel={row.type === 'source' ? scopeOf(row.profile) : null}
              onDragSource={
                row.type === 'source' && !filter ? () => setDragged(row.profile.id) : undefined
              }
              onDropSource={dragged ? () => dropOn(row) : undefined}
            />
          ))}
          {filter && rows.length === 0 && (
            <li className="px-3 py-2 text-muted">No loaded objects match “{filter}”.</li>
          )}
        </ul>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`${menu.row.type === 'node' ? menu.row.node.name : menu.row.type === 'folder' ? menu.row.folder.name : menu.row.profile.name} actions`}
          items={menuItems(menu.row)}
          onClose={() => setMenu(null)}
        />
      )}
      {quickInfo && <QuickInfo target={quickInfo} onClose={() => setQuickInfo(null)} />}
      {tool?.kind === 'table' && (
        <TableDialog
          source={tool.source}
          schema={tool.schema}
          table={tool.table}
          onApplied={() => afterChange(tool.source.id, tool.schema)}
          onClose={() => setTool(null)}
        />
      )}
      {tool?.kind === 'drop' && (
        <DropDialog
          source={tool.source}
          objects={tool.objects}
          label={tool.label}
          onApplied={() =>
            afterChange(
              tool.source.id,
              tool.objects.some((o) => o.kind === 'schema')
                ? null
                : (tool.objects[0]?.schema ?? null),
            )
          }
          onClose={() => setTool(null)}
        />
      )}
      {tool?.kind === 'truncate' && (
        <TruncateDialog
          source={tool.source}
          tables={tool.tables}
          onApplied={() => afterChange(tool.source.id, tool.tables[0]?.schema ?? null)}
          onClose={() => setTool(null)}
        />
      )}
      {tool?.kind === 'rename' && (
        <RenameDialog
          source={tool.source}
          object={tool.object}
          current={tool.current}
          onApplied={() =>
            afterChange(tool.source.id, tool.object.kind === 'schema' ? null : tool.object.schema)
          }
          onClose={() => setTool(null)}
        />
      )}
      {folderTool?.kind === 'edit' && (
        <FolderDialog folder={folderTool.folder} onClose={() => setFolderTool(null)} />
      )}
      {folderTool?.kind === 'move' && (
        <MoveDialog profile={folderTool.profile} onClose={() => setFolderTool(null)} />
      )}
      {folderTool?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete Folder"
          confirmLabel="Delete"
          danger
          onClose={() => setFolderTool(null)}
          onConfirm={async () => {
            await useConnections.getState().removeFolder(folderTool.folder.id);
          }}
        >
          <p>
            Delete folder <strong>{folderTool.folder.name}</strong>? Its data sources are kept and
            move to the top level.
          </p>
        </ConfirmDialog>
      )}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete Data Source"
          confirmLabel="Delete"
          danger
          onClose={() => setPendingDelete(null)}
          onConfirm={async () => {
            resetSource(pendingDelete.id);
            await remove(pendingDelete.id);
          }}
        >
          <p>
            Delete <strong>{pendingDelete.name}</strong>? This cannot be undone.
          </p>
          {pendingDelete.passwordSaved && (
            <p className="text-muted">Its saved password will also be removed.</p>
          )}
        </ConfirmDialog>
      )}
    </section>
  );
}

type SchemaTool =
  | { kind: 'table'; source: Profile; schema: string; table?: string }
  | { kind: 'drop'; source: Profile; objects: DropObject[]; label: string }
  | { kind: 'truncate'; source: Profile; tables: TableName[] }
  | { kind: 'rename'; source: Profile; object: RenameObject; current: string };
