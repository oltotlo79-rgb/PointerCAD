/** Certified real J/I ranges. J uses DLMF 10.9.2: |d^r J_n/dx^r| <= 1.
 * I_n has positive power-series coefficients on x>=0 and parity (-1)^n.
 * Derivatives use DLMF 10.6.1 and 10.29.1, including the removable point x=0.
 */
import { exactDouble } from './exactDoubleInterval.js';
import type { ExactRational } from './exactRational.js';
import { intervalAdd, intervalSubtract, intervalMultiply, nextFloat, type MathInterval, type IntervalValue } from './mathInterval.js';
import { BESSEL_INTEGER_ARGUMENT_LIMIT, BESSEL_INTEGER_ORDER_LIMIT, integerBesselSeries, type IntegerBesselKind } from './besselIntegerSeries.js';

type Range = MathInterval | null;
const proceed = () => undefined;
const unpack = (value: IntervalValue): Range => value.status === 'range' ? value.interval : null;
const add = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalAdd(a, b));
const subtract = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalSubtract(a, b));
const scale = (a: Range, factor: number): Range => a === null ? null : unpack(intervalMultiply(a, { lower: factor, upper: factor }));
const compare = (a: ExactRational, b: ExactRational): bigint => a.numerator * b.denominator - b.numerator * a.denominator;

function pointRange(kind: IntegerBesselKind, order: number, x: number, check: () => void): Range {
  const input = exactDouble(x);
  if (input === null) return null;
  const bounds = integerBesselSeries(kind, order, input, check);
  let lower = Number(bounds.decimal), upper = lower;
  // Seed with a decimal, but establish containment by exact binary-rational comparisons.
  // A positive value below Number.MIN_VALUE becomes [0, MIN_VALUE], never [0, 0].
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const lo = exactDouble(lower), hi = exactDouble(upper);
    if (lo === null || hi === null) return null;
    const below = compare(lo, bounds.lower) <= 0n, above = compare(hi, bounds.upper) >= 0n;
    if (below && above) return { lower, upper };
    if (!below) lower = nextFloat(lower, -1);
    if (!above) upper = nextFloat(upper, 1);
  }
  return null;
}

function valueRange(kind: IntegerBesselKind, order: number, input: MathInterval, check: () => void): Range {
  if (input.lower === input.upper) return pointRange(kind, order, input.lower, check);
  if (kind === 'J') {
    if (input.upper - input.lower >= 2) return { lower: -1, upper: 1 };
    const center = input.lower / 2 + input.upper / 2;
    const radius = nextFloat(Math.max(center - input.lower, input.upper - center), 1);
    const value = pointRange(kind, order, center, check);
    return value === null ? null : {
      lower: Math.max(-1, nextFloat(value.lower - radius, -1)),
      upper: Math.min(1, nextFloat(value.upper + radius, 1)),
    };
  }
  const left = pointRange(kind, order, input.lower, check), right = pointRange(kind, order, input.upper, check);
  if (left === null || right === null) return null;
  const zero = input.lower <= 0 && input.upper >= 0 ? (order === 0 ? 1 : 0) : left.lower;
  return { lower: Math.min(left.lower, right.lower, zero), upper: Math.max(left.upper, right.upper, zero) };
}

function valid(kind: IntegerBesselKind, order: number, input: MathInterval): boolean {
  return (kind === 'J' || kind === 'I') && Number.isSafeInteger(order) && Math.abs(order) <= BESSEL_INTEGER_ORDER_LIMIT
    && Number.isFinite(input.lower) && Number.isFinite(input.upper) && input.lower <= input.upper
    && input.lower >= -BESSEL_INTEGER_ARGUMENT_LIMIT && input.upper <= BESSEL_INTEGER_ARGUMENT_LIMIT;
}

export function integerBesselValueRange(kind: IntegerBesselKind, order: number, input: MathInterval,
  check: () => void = proceed): Range {
  check();
  return valid(kind, order, input) ? valueRange(kind, order, input, check) : null;
}

export interface IntegerBesselRanges { readonly value: Range; readonly first: Range; readonly second: Range }
export function integerBesselRanges(kind: IntegerBesselKind, order: number, input: MathInterval,
  check: () => void = proceed): IntegerBesselRanges {
  check();
  if (!valid(kind, order, input)) return { value: null, first: null, second: null };
  const value = valueRange(kind, order, input, check);
  const minusOne = valueRange(kind, order - 1, input, check), plusOne = valueRange(kind, order + 1, input, check);
  const minusTwo = valueRange(kind, order - 2, input, check), plusTwo = valueRange(kind, order + 2, input, check);
  const first = scale(kind === 'J' ? subtract(minusOne, plusOne) : add(minusOne, plusOne), 0.5);
  const outer = add(minusTwo, plusTwo), middle = scale(value, 2);
  const second = scale(kind === 'J' ? subtract(outer, middle) : add(outer, middle), 0.25);
  check();
  return { value, first, second };
}
