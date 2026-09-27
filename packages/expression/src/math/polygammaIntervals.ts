/** Directed ranges for psi^(n). Positive Laplace-kernel remainders are enclosed
 * before recurrence/reflection; negative intervals must stay in one pole-free cell.
 */
import { intervalAdd, intervalSubtract, intervalMultiply, intervalDivide,
  type MathInterval, type IntervalValue } from './mathInterval.js';
import { exactDoubleInterval } from './exactDoubleInterval.js';
import { logarithmicPositiveRange } from './logarithmicIntervals.js';
import { gammaReflectionTrig } from './gammaFunctionIntervals.js';
import { STIRLING_COEFFICIENTS } from './gammaStirlingCoefficients.js';
import { MAX_POLYGAMMA_ORDER, risingInteger, cotangentDerivativeCoefficients } from './polygammaCoefficients.js';

type Range = MathInterval | null;
const point = (value: number): MathInterval => ({ lower: value, upper: value });
const ONE = point(1), PI = { lower: 3.141592653589793, upper: 3.1415926535897936 };
const unpack = (value: IntervalValue): Range => value.status === 'range' ? value.interval : null;
const add = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalAdd(a, b));
const subtract = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalSubtract(a, b));
const multiply = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalMultiply(a, b));
const divide = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalDivide(a, b));
const negate = (a: Range): Range => a === null ? null : { lower: -a.upper, upper: -a.lower };
const exact = (numerator: bigint, denominator = 1n): Range => exactDoubleInterval({ numerator, denominator });
function power(base: Range, exponent: number): Range {
  let result: Range = ONE;
  for (let index = 0; index < exponent; index++) result = multiply(result, base);
  return result;
}

function positive(order: number, input: MathInterval): Range {
  const shifts = Math.max(0, Math.ceil(32-input.lower));
  const z = shifts === 0 ? input : add(input, point(shifts));
  if (z === null) return null;
  const inverse = divide(ONE, z), sign = order % 2 === 0 ? -1 : 1;
  const factorial = exact(risingInteger(1, order));
  let value: Range = order === 0 ? subtract(logarithmicPositiveRange(z, 'e'), multiply(point(0.5), inverse))
    : multiply(point(sign), add(multiply(exact(risingInteger(1, order-1)), power(inverse, order)),
      multiply(multiply(factorial, point(0.5)), power(inverse, order+1))));
  let currentPower = power(inverse, order+2);
  for (let index = 0; index < 9; index++) {
    const [numerator, denominator] = STIRLING_COEFFICIENTS[index];
    const coefficient = exact(BigInt(sign)*BigInt(numerator)*risingInteger(2*index+1, order+1), BigInt(denominator));
    const term = multiply(coefficient, currentPower);
    if (term === null) return null;
    value = add(value, index === 8 ? { lower: Math.min(0, term.lower), upper: Math.max(0, term.upper) } : term);
    currentPower = multiply(currentPower, multiply(inverse, inverse));
  }
  for (let index = 0; index < shifts; index++) {
    const reciprocal = divide(ONE, index === 0 ? input : add(input, point(index)));
    value = add(value, multiply(point(sign), multiply(factorial, power(reciprocal, order+1))));
  }
  return value;
}

export function polygammaRange(order: number, input: MathInterval): Range {
  if (!Number.isInteger(order) || order < 0 || order > MAX_POLYGAMMA_ORDER
    || !Number.isFinite(input.lower) || !Number.isFinite(input.upper) || input.lower > input.upper
    || input.lower < -19_999 || input.upper > 20_000) return null;
  if (input.lower <= 0 && Math.ceil(input.lower) <= Math.floor(Math.min(input.upper, 0))) return null;
  let result: Range;
  if (input.lower > 0) result = positive(order, input);
  else {
    const reflected = subtract(ONE, input);
    if (reflected === null) return null;
    const base = positive(order, reflected), { sine, cosine } = gammaReflectionTrig(input);
    const cotangent = divide(cosine, sine), coefficients = cotangentDerivativeCoefficients(order);
    let polynomial: Range = point(0);
    for (let index = coefficients.length-1; index >= 0; index--) {
      polynomial = add(multiply(polynomial, cotangent), exact(coefficients[index]));
    }
    result = subtract(order % 2 === 0 ? base : negate(base), multiply(power(PI, order+1), polynomial));
  }
  return result !== null && Number.isFinite(result.lower) && Number.isFinite(result.upper) ? result : null;
}

export function polygammaSample(order: number, input: number): number {
  const range = polygammaRange(order, point(input));
  return range === null ? NaN : range.lower/2+range.upper/2;
}
