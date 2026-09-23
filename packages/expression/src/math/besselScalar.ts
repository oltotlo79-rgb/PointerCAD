/** Use the proved integer-order kernels for all scalar geometry paths. */
import type { BesselKind } from './besselFunctions.js';
import type { MathInterval } from './mathInterval.js';
import { integerBesselValueRange, integerBesselRanges } from './besselIntegerIntervals.js';
import { secondBesselRanges } from './besselSecondKindIntervals.js';

export function besselRanges(kind: BesselKind, order: number, input: MathInterval) {
  return kind === 'J' || kind === 'I' ? integerBesselRanges(kind, order, input) : secondBesselRanges(kind, order, input);
}
export function besselValueRange(kind: BesselKind, order: number, input: MathInterval): MathInterval | null {
  return kind === 'J' || kind === 'I' ? integerBesselValueRange(kind, order, input) : secondBesselRanges(kind, order, input).value;
}
export function besselSample(kind: BesselKind, order: number, input: number): number {
  const range = besselValueRange(kind, order, { lower: input, upper: input });
  return pointFromRange(range);
}

/** An enclosure containing nonzero values must not become a made-up zero point. */
function pointFromRange(range: MathInterval | null): number {
  if (range === null) return NaN;
  if (range.lower === range.upper) return range.lower;
  if (range.lower <= 0 && range.upper >= 0) return NaN;
  const value = range.lower/2+range.upper/2;
  return value === 0 ? NaN : value;
}

export function besselSlope(kind: BesselKind, order: number, input: number): number {
  // The power series proves these origin derivatives exactly. Interval rounding
  // may enclose them with subnormal endpoints; it is not a proof of nonzero slope.
  if (input === 0 && (kind === 'J' || kind === 'I')) {
    return Math.abs(order) === 1 ? kind === 'J' && order < 0 ? -0.5 : 0.5 : 0;
  }
  return pointFromRange(besselRanges(kind, order, { lower: input, upper: input }).first);
}
