import { describe, expect, it } from 'vitest';
import { ENVIRONMENTS, readableTextOn } from './model';

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b2] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('readableTextOn', () => {
  it('reaches WCAG AA (4.5:1) on every environment color and on arbitrary colors', () => {
    const colors = [
      ...ENVIRONMENTS.flatMap((e) => (e.color ? [e.color] : [])),
      '#000000',
      '#ffffff',
      '#777777',
      '#808080',
      '#ff0000',
      '#00ff00',
      '#0000ff',
      '#ffff00',
      '#3f9d5a',
    ];
    for (const color of colors) {
      expect(contrast(readableTextOn(color), color), color).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps white text on the default production color', () => {
    expect(readableTextOn('#c43a3a')).toBe('#ffffff');
  });

  it('falls back to white for values it cannot parse', () => {
    expect(readableTextOn('red')).toBe('#ffffff');
  });
});
