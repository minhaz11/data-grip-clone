import type {
  AppError,
  ConnectionProfile,
  Folder,
  MetaNode,
  MetadataRequest,
} from '../../ipc/types';

/** Separates path segments in tree keys; cannot appear in identifiers typed by users. */
export const SEP = '\u001f';

export const ROOT_REQUEST: MetadataRequest = { level: 'schemas' };

export type Loaded =
  | { status: 'loading' }
  | { status: 'loaded'; nodes: MetaNode[] }
  | { status: 'error'; error: AppError };

interface Base {
  key: string;
  level: number;
}

interface InSource extends Base {
  profile: ConnectionProfile;
}

export type Row =
  | (Base & {
      type: 'folder';
      folder: Folder;
      /** Data sources in the folder (all of them, also when a filter hides some). */
      count: number;
      expanded: boolean;
      posinset: number;
      setsize: number;
    })
  | (InSource & {
      type: 'source';
      /** The folder row's key, or `null` at the top level. */
      parentKey: string | null;
      expanded: boolean;
      posinset: number;
      setsize: number;
    })
  | (InSource & {
      type: 'node';
      node: MetaNode;
      parentKey: string;
      expanded: boolean;
      posinset: number;
      setsize: number;
    })
  | (InSource & {
      type: 'status';
      parentKey: string;
      status: 'loading' | 'error' | 'empty';
      error?: AppError;
      /** Children were never requested: the explorer should load `request` for `parentKey`. */
      needsLoad?: MetadataRequest;
    });

export const childKey = (parentKey: string, node: MetaNode) => `${parentKey}${SEP}${node.key}`;

/** Key of a folder row; cannot collide with data source ids (UUIDs). */
export const folderKey = (folderId: string) => `#folder${SEP}${folderId}`;

/** True for `key` itself and every key below it. */
export const isWithin = (key: string, root: string) => key === root || key.startsWith(root + SEP);

/**
 * Visible rows, depth first: folders (open unless collapsed) with their data sources, then the
 * data sources outside any folder. Without a filter, expanded nodes show their children (or a
 * status row). With a filter, only loaded nodes are searched; ancestors of matches are shown
 * expanded, and folders without a match are hidden.
 */
export function flattenTree(
  profiles: ConnectionProfile[],
  children: Record<string, Loaded | undefined>,
  expanded: Record<string, boolean | undefined>,
  filter: string,
  folders: Folder[] = [],
): Row[] {
  const rows: Row[] = [];
  const needle = filter.trim().toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(needle);

  // Whether a loaded subtree contains a match (memoized per key for this pass).
  const memo = new Map<string, boolean>();
  function subtreeMatches(key: string): boolean {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const loaded = children[key];
    const result =
      loaded?.status === 'loaded' &&
      loaded.nodes.some((n) => matches(n.name) || subtreeMatches(childKey(key, n)));
    memo.set(key, result);
    return result;
  }

  function emitChildren(
    parentKey: string,
    level: number,
    profile: ConnectionProfile,
    request: MetadataRequest,
  ) {
    const loaded = children[parentKey];
    if (!needle) {
      if (!loaded || loaded.status === 'loading') {
        rows.push({
          type: 'status',
          key: `${parentKey}${SEP}#status`,
          level,
          profile,
          parentKey,
          status: 'loading',
          needsLoad: loaded ? undefined : request,
        });
        return;
      }
      if (loaded.status === 'error') {
        rows.push({
          type: 'status',
          key: `${parentKey}${SEP}#status`,
          level,
          profile,
          parentKey,
          status: 'error',
          error: loaded.error,
        });
        return;
      }
      if (loaded.nodes.length === 0) {
        rows.push({
          type: 'status',
          key: `${parentKey}${SEP}#status`,
          level,
          profile,
          parentKey,
          status: 'empty',
        });
        return;
      }
    }
    if (loaded?.status !== 'loaded') return;

    const visible = needle
      ? loaded.nodes.filter((n) => matches(n.name) || subtreeMatches(childKey(parentKey, n)))
      : loaded.nodes;
    visible.forEach((node, i) => {
      const key = childKey(parentKey, node);
      const open = node.children !== undefined && (needle ? subtreeMatches(key) : !!expanded[key]);
      rows.push({
        type: 'node',
        key,
        level,
        profile,
        node,
        parentKey,
        expanded: open,
        posinset: i + 1,
        setsize: visible.length,
      });
      if (open && node.children) emitChildren(key, level + 1, profile, node.children);
    });
  }

  function emitSources(list: ConnectionProfile[], level: number, parentKey: string | null) {
    list.forEach((profile, i) => {
      const open = needle ? subtreeMatches(profile.id) : !!expanded[profile.id];
      rows.push({
        type: 'source',
        key: profile.id,
        level,
        profile,
        parentKey,
        expanded: open,
        posinset: i + 1,
        setsize: list.length,
      });
      if (open) {
        emitChildren(profile.id, level + 1, profile, ROOT_REQUEST);
      }
    });
  }

  const known = new Set(folders.map((f) => f.id));
  const visible = (p: ConnectionProfile) => !needle || matches(p.name) || subtreeMatches(p.id);
  const grouped = folders
    .map((folder) => {
      const members = profiles.filter((p) => p.folderId === folder.id);
      return { folder, members, shown: members.filter(visible) };
    })
    .filter((g) => !needle || g.shown.length > 0);
  // A data source whose folder is gone shows at the top level.
  const loose = profiles.filter((p) => !p.folderId || !known.has(p.folderId)).filter(visible);
  const setsize = grouped.length + loose.length;
  grouped.forEach(({ folder, members, shown }, i) => {
    const key = folderKey(folder.id);
    const open = needle ? true : expanded[key] !== false;
    rows.push({
      type: 'folder',
      key,
      level: 1,
      folder,
      count: members.length,
      expanded: open,
      posinset: i + 1,
      setsize,
    });
    if (open) {
      emitSources(shown, 2, key);
    }
  });
  const offset = grouped.length;
  emitSources(loose, 1, null);
  // Top-level data sources follow the folders in one sibling set.
  for (const r of rows) {
    if (r.type === 'source' && r.parentKey === null) {
      r.posinset += offset;
      r.setsize = setsize;
    }
  }
  return rows;
}
