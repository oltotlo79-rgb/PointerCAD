/** DLMF 7.6.2 positive series with a tail bound; 7.9.1 positive continued fractions.
 * Basic operations round outward. A Math.erf-style approximation is not a certificate.
 */
import { intervalAdd, intervalSubtract, intervalMultiply, intervalDivide, intervalSquare, intervalSqrt,
  type MathInterval, type IntervalValue } from './mathInterval.js';
import { exponentialRange } from './exponentialIntervals.js';

type Range = MathInterval | null;
const point = (value: number): MathInterval => ({ lower: value, upper: value });
const ZERO = point(0), ONE = point(1), TWO = point(2);
const unpack = (value: IntervalValue): Range => value.status === 'range' ? value.interval : null;
const add = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalAdd(a, b));
const subtract = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalSubtract(a, b));
const multiply = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalMultiply(a, b));
const divide = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalDivide(a, b));
const SQRT_PI = unpack(intervalSqrt({ lower: 3.141592653589793, upper: 3.1415926535897936 }));
export const ERROR_FUNCTION_SLOPE = divide(TWO, SQRT_PI);

function exponentialNegativeSquare(x: MathInterval): Range {
  const square = unpack(intervalSquare(x));
  return square === null ? null : exponentialRange({ lower: -square.upper, upper: -square.lower });
}

function centralErf(x: number): Range {
  const input = point(x), square = unpack(intervalSquare(input)), twiceSquare = multiply(TWO, square);
  let term: Range = input, sum: Range = input;
  for (let n = 1; n <= 64; n++) {
    term = divide(multiply(term, twiceSquare), point(2*n+1));
    sum = add(sum, term);
  }
  // Omitted terms are positive and their ratios decrease after this index.
  const next = divide(multiply(term, twiceSquare), point(131));
  const tail = divide(next, subtract(ONE, divide(twiceSquare, point(133))));
  const total = tail === null ? null : add(sum, { lower: 0, upper: tail.upper });
  return multiply(multiply(ERROR_FUNCTION_SLOPE, exponentialNegativeSquare(input)), total);
}

function tailConvergent(x: MathInterval, depth: number): Range {
  let tail: Range = ZERO;
  for (let n = depth; n >= 1; n--) tail = divide(point(n/2), add(x, tail));
  return divide(ONE, add(x, tail));
}

function positiveErfc(x: number): Range {
  if (x <= 2) return subtract(ONE, centralErf(x));
  const input = point(x), a = tailConvergent(input, 96), b = tailConvergent(input, 97);
  if (a === null || b === null) return null;
  // Positive adjacent convergents bracket the infinite continued fraction.
  const bracket = { lower: Math.min(a.lower, b.lower), upper: Math.max(a.upper, b.upper) };
  return multiply(divide(exponentialNegativeSquare(input), SQRT_PI), bracket);
}

function errorPoint(id: 'erf' | 'erfc', x: number): Range {
  if (!Number.isFinite(x) || Math.abs(x) > 500_000) return null;
  if (x === 0) return id === 'erf' ? ZERO : ONE;
  const magnitude = Math.abs(x);
  const positive = id === 'erf' && magnitude <= 2 ? centralErf(magnitude)
    : id === 'erfc' ? positiveErfc(magnitude) : subtract(ONE, positiveErfc(magnitude));
  if (positive === null) return null;
  const clipped = { lower: Math.max(0, positive.lower), upper: Math.min(1, positive.upper) };
  return x > 0 ? clipped : id === 'erf' ? { lower: -clipped.upper, upper: -clipped.lower } : subtract(TWO, clipped);
}

/** Monotonicity encloses the entire real input interval, not only sampled points. */
export function errorFunctionRange(id: 'erf' | 'erfc', input: MathInterval): Range {
  if (input.lower > input.upper) return null;
  const a = errorPoint(id, input.lower), b = errorPoint(id, input.upper);
  return a === null || b === null ? null : id === 'erf'
    ? { lower: a.lower, upper: b.upper } : { lower: b.lower, upper: a.upper };
}

export function errorFunctionSample(id: 'erf' | 'erfc', x: number): number {
  const enclosed = errorPoint(id, x);
  if (enclosed === null) return NaN;
  if (enclosed.lower <= 0 && enclosed.upper >= 0 && (id === 'erfc' || x !== 0)) return NaN;
  const value = enclosed.lower + (enclosed.upper-enclosed.lower)/2;
  // erf(x) has its only zero at zero; erfc is positive at every finite real x.
  return value === 0 && (id === 'erfc' || x !== 0) ? NaN : value;
}

export function errorFunctionDerivative(id: 'erf' | 'erfc', input: MathInterval): Range {
  if (!Number.isFinite(input.lower) || !Number.isFinite(input.upper) || input.lower > input.upper) return null;
  const slope = multiply(ERROR_FUNCTION_SLOPE, exponentialNegativeSquare(input));
  return slope === null ? null : id === 'erf' ? slope : { lower: -slope.upper, upper: -slope.lower };
}
