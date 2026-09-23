/** Positive real Beta and its two-variable derivatives. DLMF 5.12.1.
 * The positive integral is decreasing in each argument; endpoint values bound a box.
 * All logarithms and derivatives use directed enclosures, not rounded samples.
 */
import { intervalAdd, intervalSubtract, intervalMultiply, intervalDivide, intervalSquare,
  type MathInterval, type IntervalValue } from './mathInterval.js';
import { exactDouble, exactDoubleInterval } from './exactDoubleInterval.js';
import { rational, type ExactRational } from './exactRational.js';
import { logGammaPositiveRange } from './gammaFunctionIntervals.js';
import { polygammaRange } from './polygammaIntervals.js';
import { exponentialRange } from './exponentialIntervals.js';

type Range = MathInterval | null;
const point = (value: number): MathInterval => ({ lower: value, upper: value });
const ONE = point(1);
const unpack = (value: IntervalValue): Range => value.status === 'range' ? value.interval : null;
const add = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalAdd(a, b));
const subtract = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalSubtract(a, b));
const multiply = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalMultiply(a, b));
const divide = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalDivide(a, b));
const square = (a: Range): Range => a === null ? null : unpack(intervalSquare(a));
const finite = (value: Range): Range => value !== null && Number.isFinite(value.lower) && Number.isFinite(value.upper) ? value : null;

function polygammaDifference(order: 0 | 1, base: MathInterval, shift: MathInterval, sum: MathInterval): Range {
  const direct = subtract(polygammaRange(order, base), polygammaRange(order, sum));
  // psi_n(x)-psi_n(x+h) = -integral_0^h psi_(n+1)(x+t) dt.
  // This enclosure retains tiny h even when x+h rounds to x. Intersect with
  // the direct difference: both contain every original pair in the input box.
  const integral = multiply({ lower: -shift.upper, upper: -shift.lower },
    polygammaRange(order+1, { lower: base.lower, upper: sum.upper }));
  if (direct === null) return integral;
  if (integral === null) return direct;
  const lower = Math.max(direct.lower, integral.lower), upper = Math.min(direct.upper, integral.upper);
  return lower <= upper ? { lower, upper } : null;
}

function exactSum(a: number, b: number): ExactRational | null {
  const x = exactDouble(a), y = exactDouble(b);
  return x === null || y === null ? null : rational(x.numerator*y.denominator+y.numerator*x.denominator,
    x.denominator*y.denominator);
}
function sumRange(a: MathInterval, b: MathInterval): Range {
  const lower = exactSum(a.lower, b.lower), upper = exactSum(a.upper, b.upper);
  if (lower === null || upper === null || upper.numerator > 20_000n*upper.denominator) return null;
  const l = exactDoubleInterval(lower), u = exactDoubleInterval(upper);
  return l === null || u === null ? null : { lower: l.lower, upper: u.upper };
}
function valid(input: MathInterval): boolean {
  return Number.isFinite(input.lower) && Number.isFinite(input.upper) && input.lower > 0 && input.lower <= input.upper;
}
function betaPoint(a: number, b: number): Range {
  if (a === 1) return divide(ONE, point(b));
  if (b === 1) return divide(ONE, point(a));
  const sum = sumRange(point(a), point(b));
  if (sum === null) return null;
  const logarithm = subtract(add(logGammaPositiveRange(point(a)), logGammaPositiveRange(point(b))),
    logGammaPositiveRange(sum));
  return logarithm === null ? null : exponentialRange(logarithm);
}

export interface BetaFunctionRanges {
  readonly value: Range;
  readonly da: Range;
  readonly db: Range;
  readonly daa: Range;
  readonly dbb: Range;
  readonly dab: Range;
}
const UNKNOWN: BetaFunctionRanges = { value: null, da: null, db: null, daa: null, dbb: null, dab: null };

export function betaFunctionValueRange(a: MathInterval, b: MathInterval): Range {
  if (!valid(a) || !valid(b) || sumRange(a, b) === null) return null;
  const low = betaPoint(a.upper, b.upper), high = betaPoint(a.lower, b.lower);
  if (low === null || high === null) return null;
  const value = finite({ lower: low.lower, upper: high.upper });
  return value !== null && value.lower > 0 ? value : null;
}

export function betaFunctionRanges(a: MathInterval, b: MathInterval): BetaFunctionRanges {
  const value = betaFunctionValueRange(a, b), sum = sumRange(a, b);
  if (value === null || sum === null) return UNKNOWN;
  const psiPrimeSum = polygammaRange(1, sum);
  const la = polygammaDifference(0, a, b, sum), lb = polygammaDifference(0, b, a, sum);
  const laa = polygammaDifference(1, a, b, sum), lbb = polygammaDifference(1, b, a, sum);
  return { value, da: finite(multiply(value, la)), db: finite(multiply(value, lb)),
    daa: finite(multiply(value, add(square(la), laa))), dbb: finite(multiply(value, add(square(lb), lbb))),
    dab: finite(multiply(value, subtract(multiply(la, lb), psiPrimeSum))) };
}

export function betaFunctionSample(a: number, b: number): number {
  const range = betaFunctionValueRange(point(a), point(b));
  return range === null ? NaN : range.lower/2+range.upper/2;
}
