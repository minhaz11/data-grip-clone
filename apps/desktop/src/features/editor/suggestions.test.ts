import { describe, expect, it } from 'vitest';
import type { MetaNode } from '../../ipc/types';
import { completionContextAt, tablesInStatement } from '../../lib/sql/completionContext';
import { resolveRelation } from './catalog';
import { buildSuggestions, quoteIdent, type CatalogAccess } from './suggestions';

const rel = (schema: string, name: string, kind: MetaNode['kind'] = 'table'): MetaNode => ({
  key: `${schema}.${name}`,
  kind,
  name,
  detail: schema,
});
const RELATIONS = [
  rel('public', 'users'),
  rel('shop', 'orders'),
  rel('shop', 'order_totals', 'view'),
  rel('shop', 'users'),
  rel('shop', 'Line Items'),
];
const COLUMNS: Record<string, string[]> = {
  'public.users': ['id', 'email'],
  'shop.orders': ['id', 'customer_id', 'status'],
};

const catalog: CatalogAccess = {
  relations: RELATIONS,
  columnsOf: async (r) =>
    (COLUMNS[r.key] ?? []).map((c) => ({ key: `c:${c}`, kind: 'column', name: c, detail: 'text' })),
};

async function suggest(sqlWithCaret: string) {
  const offset = sqlWithCaret.indexOf('|');
  const sql = sqlWithCaret.replace('|', '');
  const { context, statement } = completionContextAt(sql, offset);
  return buildSuggestions(context, tablesInStatement(statement), catalog);
}

describe('completion suggestions', () => {
  it('offers relations after FROM, qualifying non-public and ambiguous names', async () => {
    const items = await suggest('select * from |');
    const byInsert = items.filter((i) => i.kind !== 'schema').map((i) => i.insertText);
    expect(byInsert).toEqual([
      'public.users',
      'shop.orders',
      'shop.order_totals',
      'shop.users',
      'shop."Line Items"',
    ]);
    expect(items.find((i) => i.label === 'order_totals')?.kind).toBe('view');
    expect(items.filter((i) => i.kind === 'schema').map((i) => i.label)).toEqual([
      'public',
      'shop',
    ]);
  });

  it('completes columns through aliases and table names', async () => {
    expect((await suggest('select o.| from shop.orders o')).map((i) => i.label)).toEqual([
      'id',
      'customer_id',
      'status',
    ]);
    expect(
      (await suggest('select users.| from users')).map((i) => `${i.label}:${i.detail}`),
    ).toEqual(['id:users · text', 'email:users · text']);
  });

  it('completes relations inside a schema without re-qualifying', async () => {
    const items = await suggest('select * from shop.|');
    expect(items.map((i) => i.insertText)).toEqual([
      'orders',
      'order_totals',
      'users',
      '"Line Items"',
    ]);
  });

  it('mixes statement columns, relations and keywords in general position', async () => {
    const items = await suggest('select | from shop.orders');
    expect(items[0]).toMatchObject({ label: 'id', kind: 'column', rank: 0 });
    expect(items.some((i) => i.kind === 'keyword' && i.label === 'WHERE')).toBe(true);
    expect(items.findIndex((i) => i.kind === 'keyword')).toBeGreaterThan(
      items.findIndex((i) => i.kind === 'table'),
    );
  });

  it('returns nothing for unknown qualifiers and works with an empty catalog', async () => {
    expect(await suggest('select zz.| from orders')).toEqual([]);
    const { context } = completionContextAt('sel', 3);
    const items = await buildSuggestions(context, [], { relations: [], columnsOf: async () => [] });
    expect(items.every((i) => i.kind === 'keyword')).toBe(true);
  });

  it('quotes identifiers only when needed and resolves public first', () => {
    expect([
      quoteIdent('orders'),
      quoteIdent('Orders'),
      quoteIdent('order'),
      quoteIdent('a"b'),
    ]).toEqual(['orders', '"Orders"', '"order"', '"a""b"']);
    expect(resolveRelation(RELATIONS, { table: 'users' })?.detail).toBe('public');
    expect(resolveRelation(RELATIONS, { schema: 'shop', table: 'users' })?.detail).toBe('shop');
    expect(resolveRelation(RELATIONS, { table: 'nope' })).toBeUndefined();
  });
});
