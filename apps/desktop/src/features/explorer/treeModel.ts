import type { AppError, ConnectionProfile, MetaNode, MetadataRequest } from '../../ipc/types';

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
  profile: ConnectionProfile;
}

export type Row =
  | (Base & { type: 'source'; expanded: boolean; posinset: number; setsize: number })
  | (Base & {
      type: 'node';
      node: MetaNode;
      parentKey: string;
      expanded: boolean;
      posinset: number;
      setsize: number;
    })
  | (Base & {
      type: 'status';
      parentKey: string;
      status: 'loading' | 'error' | 'empty';
      error?: AppError;
      /** Children were never requested: the explorer should load `request` for `parentKey`. */
      needsLoad?: MetadataRequest;
    });

export const childKey = (parentKey: string, node: MetaNode) => `${parentKey}${SEP}${node.key}`;

/** True for `key` itself and every key below it. */
export const isWithin = (key: string, root: string) => key === root || key.startsWith(root + SEP);

/**
 * Visible rows, depth first. Without a filter, expanded nodes show their children (or a status
 * row). With a filter, only loaded nodes are searched; ancestors of matches are shown expanded.
 */
export function flattenTree(
  profiles: ConnectionProfile[],
  children: Record<string, Loaded | undefined>,
  expanded: Record<string, boolean | undefined>,
  filter: string,
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

  const sources = needle
    ? profiles.filter((p) => matches(p.name) || subtreeMatches(p.id))
    : profiles;
  sources.forEach((profile, i) => {
    const open = needle ? subtreeMatches(profile.id) : !!expanded[profile.id];
    rows.push({
      type: 'source',
      key: profile.id,
      level: 1,
      profile,
      expanded: open,
      posinset: i + 1,
      setsize: sources.length,
    });
    if (open) emitChildren(profile.id, 2, profile, ROOT_REQUEST);
  });
  return rows;
}
