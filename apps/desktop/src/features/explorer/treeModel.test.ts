import { describe, expect, it } from 'vitest';
import type { ConnectionProfile, MetaNode } from '../../ipc/types';
import { NEW_DRAFT } from '../connections/model';
import { flattenTree, SEP, type Loaded } from './treeModel';

const profile = (id: string, name: string): ConnectionProfile => ({
  ...NEW_DRAFT,
  id,
  name,
  passwordSaved: false,
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
});
const node = (key: string, name: string, expandable = true): MetaNode => ({
  key,
  kind: expandable ? 'schema' : 'column',
  name,
  children: expandable ? { level: 'schemaGroups', schema: name } : undefined,
});
const loaded = (...nodes: MetaNode[]): Loaded => ({ status: 'loaded', nodes });
const k = (...parts: string[]) => parts.join(SEP);

describe('flattenTree', () => {
  const a = profile('a', 'Alpha');
  const b = profile('b', 'Beta');

  it('shows sources collapsed, then a pending-load row when expanded', () => {
    expect(flattenTree([a, b], {}, {}, '').map((r) => r.key)).toEqual(['a', 'b']);
    const rows = flattenTree([a], {}, { a: true }, '');
    expect(rows[1]).toMatchObject({
      type: 'status',
      status: 'loading',
      parentKey: 'a',
      needsLoad: { level: 'schemas' },
    });
  });

  it('nests expanded levels with positions and empty/error rows', () => {
    const children = {
      a: loaded(node('s:public', 'public'), node('s:shop', 'shop')),
      [k('a', 's:public')]: loaded(),
      [k('a', 's:shop')]: { status: 'error', error: { kind: 'db', message: 'boom' } } as Loaded,
    };
    const rows = flattenTree(
      [a],
      children,
      { a: true, [k('a', 's:public')]: true, [k('a', 's:shop')]: true },
      '',
    );
    expect(
      rows.map((r) => [
        r.type,
        r.level,
        r.type === 'status'
          ? r.status
          : r.type === 'node'
            ? r.node.name
            : r.type === 'source'
              ? r.profile.name
              : r.folder.name,
      ]),
    ).toEqual([
      ['source', 1, 'Alpha'],
      ['node', 2, 'public'],
      ['status', 3, 'empty'],
      ['node', 2, 'shop'],
      ['status', 3, 'error'],
    ]);
    expect(rows[3]).toMatchObject({ posinset: 2, setsize: 2 });
  });

  it('filters loaded nodes, revealing ancestors of deep matches', () => {
    const children = {
      a: loaded(node('s:public', 'public'), node('s:shop', 'shop')),
      [k('a', 's:shop')]: loaded(
        node('c:email', 'customer_email', false),
        node('c:id', 'id', false),
      ),
    };
    // Nothing expanded, yet the match deep inside "shop" is shown with its path.
    const rows = flattenTree([a, b], children, {}, 'EMAIL');
    expect(
      rows.map((r) =>
        r.type === 'node'
          ? r.node.name
          : r.type === 'source'
            ? r.profile.name
            : r.type === 'folder'
              ? r.folder.name
              : r.status,
      ),
    ).toEqual(['Alpha', 'shop', 'customer_email']);
    expect(rows[1]).toMatchObject({ expanded: true, posinset: 1, setsize: 1 });
    expect(flattenTree([a, b], children, {}, 'bet').map((r) => r.key)).toEqual(['b']);
    expect(flattenTree([a, b], children, {}, 'zzz')).toEqual([]);
  });
});
