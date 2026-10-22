import { describe, expect, it } from 'vitest';
import type { ForeignKeyDetail, MetaNode } from '../../ipc/types';
import { completionContextAt, tablesInStatement } from '../../lib/sql/completionContext';
import { resolveRelation } from './catalog';
import { buildSuggestions, fuzzyScore, quoteIdent, type CatalogAccess } from './suggestions';

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

  it('ranks an exact prefix first, then initials, word starts and letters in order', () => {
    expect(fuzzyScore('ord', 'orders')).toBe(0);
    expect(fuzzyScore('oi', 'order_items')).toBe(1);
    expect(fuzzyScore('it', 'order_items')).toBe(2);
    expect(fuzzyScore('odr', 'orders')).toBe(3);
    expect(fuzzyScore('xyz', 'orders')).toBeNull();
    expect(fuzzyScore('ci', 'customerId')).toBe(1);
  });
});

const fk = (
  from: [string, string, string[]],
  to: [string, string, string[]],
  name: string,
): ForeignKeyDetail => ({
  name,
  fromSchema: from[0],
  fromTable: from[1],
  fromColumns: from[2],
  toSchema: to[0],
  toTable: to[1],
  toColumns: to[2],
  onUpdate: 'NO ACTION',
  onDelete: 'NO ACTION',
  deferrable: false,
});

const SHOP = [
  rel('shop', 'customers'),
  rel('shop', 'orders'),
  rel('shop', 'order_items'),
  rel('public', 'users'),
];
const LINKS: Record<string, ForeignKeyDetail[]> = {
  'shop.orders': [
    fk(
      ['shop', 'orders', ['customer_id']],
      ['shop', 'customers', ['id']],
      'orders_customer_id_fkey',
    ),
    fk(
      ['shop', 'order_items', ['order_id']],
      ['shop', 'orders', ['id']],
      'order_items_order_id_fkey',
    ),
  ],
};
const fn = (
  schema: string,
  name: string,
  args: string,
  result: string,
  flags?: string[],
): MetaNode => ({
  key: `${schema}\u001f${name}(${args})`,
  kind: 'routine',
  name,
  detail: `(${args}) → ${result}`,
  ...(flags ? { flags } : {}),
});
const shopCatalog = (searchPath?: string[]): CatalogAccess => ({
  relations: SHOP,
  columnsOf: async () => [],
  linksOf: async (r) => LINKS[r.key] ?? [],
  functions: [
    fn('shop', 'order_total', 'order_id bigint', 'numeric'),
    fn('pg_catalog', 'count', '"any"', 'bigint', ['aggregate']),
    fn('pg_catalog', 'lower', 'text', 'text'),
    fn('pg_catalog', 'lower', 'anymultirange', 'anyelement'),
  ],
  ...(searchPath ? { searchPath } : {}),
});

async function suggestIn(sqlWithCaret: string, access: CatalogAccess) {
  const offset = sqlWithCaret.indexOf('|');
  const sql = sqlWithCaret.replace('|', '');
  const { context, statement } = completionContextAt(sql, offset);
  return buildSuggestions(context, tablesInStatement(statement), access);
}

describe('functions, joins and the search path', () => {
  it('suggests JOIN … ON from foreign keys in both directions', async () => {
    const items = await suggestIn('select * from shop.orders o join |', shopCatalog());
    const joins = items.filter((i) => i.kind === 'join');
    expect(joins.map((j) => j.insertText)).toEqual([
      'shop.customers c ON c.id = o.customer_id',
      'shop.order_items oi ON oi.order_id = o.id',
    ]);
    expect(items[0]?.kind).toBe('join'); // joins come first
    expect(joins[0]?.detail).toBe('foreign key orders_customer_id_fkey');
    // No joins outside JOIN position.
    expect(
      (await suggestIn('select * from shop.orders o, |', shopCatalog())).some(
        (i) => i.kind === 'join',
      ),
    ).toBe(false);
  });

  it('offers functions with signatures, one per name, qualified outside the search path', async () => {
    const items = await suggestIn('select lo|', shopCatalog());
    const lower = items.find((i) => i.kind === 'function' && i.label === 'lower');
    expect(lower).toMatchObject({ insertText: 'lower($0)', snippet: true });
    expect(lower?.detail).toBe('(text) → text (+1 more)');
    const all = await suggestIn('select |', shopCatalog());
    expect(all.find((i) => i.label === 'order_total')?.insertText).toBe('shop.order_total($0)');
    expect(
      (await suggestIn('select |', shopCatalog(['shop', 'public']))).find(
        (i) => i.label === 'order_total',
      )?.insertText,
    ).toBe('order_total($0)');
  });

  it('resolves unqualified names through the console schema', async () => {
    // With the console schema "shop", `orders` needs no qualifier and its columns resolve.
    // `users` exists in public and shop: the console schema decides.
    expect(resolveRelation(RELATIONS, { table: 'users' })?.detail).toBe('public');
    expect(resolveRelation(RELATIONS, { table: 'users' }, ['shop', 'public'])?.detail).toBe('shop');
    const items = await suggestIn('select * from or|', shopCatalog(['shop', 'public']));
    expect(items.find((i) => i.label === 'orders')?.insertText).toBe('orders');
    const joins = await suggestIn('select * from orders o join |', shopCatalog(['shop', 'public']));
    expect(joins[0]?.insertText).toBe('customers c ON c.id = o.customer_id');
  });

  it('filters by the typed word, exact prefix first', async () => {
    const items = await suggestIn('select * from oi|', shopCatalog());
    expect(items.map((i) => i.label)).toEqual(['order_items']);
    const ord = (await suggestIn('select * from or|', shopCatalog())).map((i) => i.label);
    expect(ord.slice(0, 2)).toEqual(['orders', 'order_items']);
  });
});
