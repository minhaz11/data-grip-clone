/**
 * Aggregates of selected cells (M4.8). Plain decimals (the text form of integer and numeric
 * columns) are summed exactly with BigInt, so large integers and money-like values do not drift;
 * values with an exponent fall back to floating point and say so.
 */

export interface Aggregates {
  /** Non-NULL cells in the selection. */
  count: number;
  /** Values that took part in sum/avg/min/max. */
  numeric: number;
  sum: string;
  avg: string;
  min: string;
  max: string;
  /** Some value needed floating point (exponent form): results are approximate. */
  approximate: boolean;
}

interface Decimal {
  units: bigint;
  scale: number;
}

const PLAIN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

function parseDecimal(text: string): Decimal | null {
  const m = PLAIN.exec(text.trim());
  if (!m) {
    return null;
  }
  const fraction = m[3] ?? '';
  const units = BigInt(`${m[1] === '-' ? '-' : ''}${m[2]}${fraction}`);
  return { units, scale: fraction.length };
}

function rescale(d: Decimal, scale: number): bigint {
  return d.units * 10n ** BigInt(scale - d.scale);
}

function formatDecimal(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? digits.slice(digits.length - scale).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

const AVG_DIGITS = 6;

/** Aggregates of `values` (cells of numeric columns); `count` covers every non-NULL cell. */
export function aggregate(values: string[], count: number): Aggregates | null {
  const decimals = values.map(parseDecimal);
  if (decimals.every((d): d is Decimal => d !== null)) {
    if (decimals.length === 0) {
      return null;
    }
    const scale = Math.max(...decimals.map((d) => d.scale));
    const scaled = decimals.map((d) => rescale(d, scale));
    const sum = scaled.reduce((a, b) => a + b, 0n);
    let min = 0;
    let max = 0;
    scaled.forEach((v, i) => {
      if (v < (scaled[min] ?? v)) {
        min = i;
      }
      if (v > (scaled[max] ?? v)) {
        max = i;
      }
    });
    // Average rounded half away from zero to AVG_DIGITS more places.
    const factor = 10n ** BigInt(AVG_DIGITS);
    const n = BigInt(scaled.length);
    const doubled = (sum * factor * 2n) / n;
    const avg = (doubled + (doubled < 0n ? -1n : 1n)) / 2n;
    return {
      count,
      numeric: values.length,
      sum: formatDecimal(sum, scale),
      avg: formatDecimal(avg, scale + AVG_DIGITS),
      min: formatDecimal(scaled[min] ?? 0n, scale),
      max: formatDecimal(scaled[max] ?? 0n, scale),
      approximate: false,
    };
  }
  const numbers = values.map(Number).filter(Number.isFinite);
  if (numbers.length === 0) {
    return null;
  }
  const sum = numbers.reduce((a, b) => a + b, 0);
  return {
    count,
    numeric: numbers.length,
    sum: String(sum),
    avg: String(sum / numbers.length),
    min: String(Math.min(...numbers)),
    max: String(Math.max(...numbers)),
    approximate: true,
  };
}
