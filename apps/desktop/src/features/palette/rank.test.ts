import { describe, expect, it } from 'vitest';
import { parseQuery, prefixesFor, rank, score, type Rankable } from './rank';

const t = (name: string, detail = 'public'): Rankable => ({ type: 'table', name, detail });

describe('palette ranking', () => {
  it('orders exact, prefix, word start, substring, then fuzzy matches', () => {
    const items = [
      t('customer_orders'),
      t('ordinal'),
      t('orders'),
      t('reorders'),
      t('o_r_d_e_r_s_x'),
      t('payments'),
    ];
    expect(rank(items, 'orders').map((i) => i.name)).toEqual([
      'orders',
      'customer_orders',
      'reorders',
      'o_r_d_e_r_s_x',
    ]);
    expect(
      rank(items, 'ORD')
        .map((i) => i.name)
        .slice(0, 3),
    ).toEqual(['orders', 'ordinal', 'customer_orders']);
  });

  it('scores camel case and separators as word starts', () => {
    const word = score('Item', 'orderItems') ?? 0;
    const inside = score('tem', 'orderItems') ?? 0;
    expect(word).toBeGreaterThan(inside);
    expect(score('xyz', 'orders')).toBeNull();
    expect(score('', 'anything')).toBe(1);
  });

  it('breaks ties by length, then name', () => {
    const items = [t('order_items_archive'), t('order_items'), t('order_b'), t('order_a')];
    expect(rank(items, 'order').map((i) => i.name)).toEqual([
      'order_a',
      'order_b',
      'order_items',
      'order_items_archive',
    ]);
  });

  it('matches schema-qualified queries against schema and name', () => {
    const items = [t('orders', 'shop'), t('orders', 'audit'), t('shipments', 'shop')];
    expect(rank(items, 'shop.ord').map((i) => `${i.detail}.${i.name}`)).toEqual(['shop.orders']);
  });

  it('narrows by type prefix', () => {
    expect(parseQuery('/tables ord')).toEqual({ types: ['table'], text: 'ord' });
    expect(parseQuery('/consoles')).toEqual({ types: ['console'], text: '' });
    expect(parseQuery('/unknown x')).toEqual({ types: null, text: '/unknown x' });
    const items: Rankable[] = [
      t('orders'),
      { type: 'view', name: 'orders_v' },
      { type: 'console', name: 'orders report' },
      { type: 'action', name: 'Open orders' },
    ];
    expect(rank(items, '/views ord').map((i) => i.name)).toEqual(['orders_v']);
    expect(rank(items, '/consoles').map((i) => i.name)).toEqual(['orders report']);
    expect(prefixesFor('/ta')).toEqual(['/tables']);
    expect(prefixesFor('/tables x')).toEqual([]);
  });

  it('ranks 1,000 tables well within 100 ms', () => {
    const items = Array.from({ length: 1000 }, (_, i) => t(`table_${i}_orders`, `schema_${i % 7}`));
    const started = performance.now();
    for (const q of ['t', 'tab', 'orders', '999', 'tbl9', 'schema_3.table']) {
      expect(rank(items, q).length).toBeGreaterThan(0);
    }
    // Six searches together, so one is far below the budget.
    expect(performance.now() - started).toBeLessThan(100);
  });
});
