/** Real hyperbolic enclosures from proved exp/log bounds and directed arithmetic.
 * Identities: https://dlmf.nist.gov/4.35 and https://dlmf.nist.gov/4.37.
 * Math.sinh/cosh/tanh rounding is never used as a certificate.
 */
import { intervalAdd, intervalSubtract, intervalMultiply, intervalDivide, intervalSquare, intervalSqrt,
  type MathInterval, type IntervalValue } from './mathInterval.js';
import { exponentialRange } from './exponentialIntervals.js';
import { logarithmicPositiveRange } from './logarithmicIntervals.js';

export type HyperbolicOperation = 'sinh' | 'cosh' | 'tanh' | 'arsinh' | 'arcosh' | 'artanh';
type Range = MathInterval | null;
const point = (value: number): MathInterval => ({ lower: value, upper: value });
const ZERO = point(0), ONE = point(1), TWO = point(2);
const unpack = (value: IntervalValue): Range => value.status === 'range' ? value.interval : null;
const add = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalAdd(a, b));
const subtract = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalSubtract(a, b));
const multiply = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalMultiply(a, b));
const divide = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalDivide(a, b));
const square = (a: Range): Range => a === null ? null : unpack(intervalSquare(a));
const root = (a: Range): Range => a === null ? null : unpack(intervalSqrt(a));
const log = (a: Range): Range => a === null ? null : logarithmicPositiveRange(a, 'e');
const negate = (a: Range): Range => a === null ? null : { lower: -a.upper, upper: -a.lower };
function positive(a: Range, minimum = 0, maximum = Infinity): Range {
  return a === null ? null : { lower: Math.max(minimum, a.lower), upper: Math.min(maximum, a.upper) };
}

function at(operation: HyperbolicOperation, value: number): Range {
  if (operation === 'arcosh' && value < 1 || operation === 'artanh' && Math.abs(value) >= 1) return null;
  if (value < 0) return operation === 'cosh' ? at(operation, -value) : negate(at(operation, -value));
  if (value === 0) return operation === 'cosh' ? ONE : ZERO;
  if (value === Infinity) return point(operation === 'tanh' ? 1 : Infinity);
  const x = point(value);
  if (operation === 'sinh' || operation === 'cosh') {
    const growing = exponentialRange(x), decaying = exponentialRange(point(-value));
    return positive(divide(operation === 'sinh' ? subtract(growing, decaying) : add(growing, decaying), TWO),
      operation === 'cosh' ? 1 : 0);
  }
  if (operation === 'tanh') {
    // exp(-2x) cannot overflow for x>=0, even when exp(x) would overflow.
    const negativeTwice = negate(multiply(TWO, x));
    const decaying = negativeTwice === null ? null : exponentialRange(negativeTwice);
    return positive(divide(subtract(ONE, decaying), add(ONE, decaying)), 0, 1);
  }
  if (operation === 'arsinh') {
    // Scaling before squaring retains finite logarithms of very large inputs.
    return positive(value > 1
      ? add(log(x), log(add(ONE, root(add(ONE, square(divide(ONE, x)))))))
      : log(add(x, root(add(square(x), ONE)))));
  }
  if (operation === 'arcosh') {
    if (value === 1) return ZERO;
    const radicand = positive(subtract(ONE, square(divide(ONE, x))));
    return positive(add(log(x), log(add(ONE, root(radicand)))));
  }
  return positive(divide(subtract(log(add(ONE, x)), log(subtract(ONE, x))), TWO));
}

/** Monotonicity, odd symmetry and cosh's minimum at zero cover the whole interval. */
export function hyperbolicRange(operation: HyperbolicOperation, input: MathInterval): Range {
  if (Number.isNaN(input.lower) || Number.isNaN(input.upper) || input.lower > input.upper) return null;
  if (operation === 'arcosh' && input.lower < 1
    || operation === 'artanh' && (input.lower <= -1 || input.upper >= 1)) return null;
  const minimum = operation === 'cosh'
    ? input.lower <= 0 && input.upper >= 0 ? 0 : Math.min(Math.abs(input.lower), Math.abs(input.upper)) : input.lower;
  const maximum = operation === 'cosh' ? Math.max(Math.abs(input.lower), Math.abs(input.upper)) : input.upper;
  const lower = at(operation, minimum), upper = minimum === maximum ? lower : at(operation, maximum);
  return lower === null || upper === null ? null : { lower: lower.lower, upper: upper.upper };
}
