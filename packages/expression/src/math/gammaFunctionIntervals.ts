/** Real Gamma and its first two derivatives, with directed arithmetic.
 * DLMF 5.11.1/2 and 5.15.8: positive Stirling expansions and signed remainder.
 * Negative intervals use 5.5.3/4 and 5.15.6, never join across a pole.
 */
import { intervalAdd, intervalSubtract, intervalMultiply, intervalDivide, intervalSquare,
  type MathInterval, type IntervalValue } from './mathInterval.js';
import { logarithmicPositiveRange } from './logarithmicIntervals.js';
import { exponentialRange } from './exponentialIntervals.js';
import { trigonometricInterval } from './trigonometricIntervals.js';
import { STIRLING_COEFFICIENTS } from './gammaStirlingCoefficients.js';

type Range = MathInterval | null;
const point = (value: number): MathInterval => ({ lower: value, upper: value });
const ONE = point(1), HALF = point(0.5);
const PI = { lower: 3.141592653589793, upper: 3.1415926535897936 };
const unpack = (value: IntervalValue): Range => value.status === 'range' ? value.interval : null;
const add = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalAdd(a, b));
const subtract = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalSubtract(a, b));
const multiply = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalMultiply(a, b));
const divide = (a: Range, b: Range): Range => a === null || b === null ? null : unpack(intervalDivide(a, b));
const square = (a: Range): Range => a === null ? null : unpack(intervalSquare(a));
const log = (a: Range): Range => a === null ? null : logarithmicPositiveRange(a, 'e');
const exp = (a: Range): Range => a === null ? null : exponentialRange(a);
const negate = (a: Range): Range => a === null ? null : { lower: -a.upper, upper: -a.lower };
const HALF_LOG_TWO_PI = multiply(HALF, log(multiply(point(2), PI)));

/** Evaluate each endpoint near its nearest integer, then use the known extrema
 * on one pole-free integer cell. A Lipschitz bound over the entire cell could
 * include zero even though sin(pi*x) keeps its sign throughout that cell.
 */
export function gammaReflectionTrig(input: MathInterval): { readonly sine: Range; readonly cosine: Range } {
  const endpoint = (x: number): { readonly sine: Range; readonly cosine: Range } => {
    // These binary64 half-integers are exact. Keeping cos(pi*x)=0 also prevents
    // artificial cancellation in even polygamma orders far along the negative axis.
    if (x-Math.floor(x) === 0.5) return {
      sine: point(Math.floor(x) % 2 === 0 ? 1 : -1), cosine: point(0),
    };
    const integer = Math.round(x), angle = multiply(PI, subtract(point(x), point(integer)));
    if (angle === null) return { sine: null, cosine: null };
    const sine = unpack(trigonometricInterval(angle, false, false));
    const cosine = unpack(trigonometricInterval(angle, true, false));
    return integer % 2 === 0 ? { sine, cosine } : { sine: negate(sine), cosine: negate(cosine) };
  };
  const a = endpoint(input.lower), b = endpoint(input.upper);
  if (a.sine === null || b.sine === null || a.cosine === null || b.cosine === null) return { sine: null, cosine: null };
  const middle = Math.floor(input.lower)+0.5;
  const includesExtremum = input.lower <= middle && input.upper >= middle;
  const positive = Math.floor(input.lower) % 2 === 0;
  return { sine: {
    lower: includesExtremum && !positive ? -1 : Math.min(a.sine.lower, b.sine.lower),
    upper: includesExtremum && positive ? 1 : Math.max(a.sine.upper, b.sine.upper),
  }, cosine: { lower: Math.min(a.cosine.lower, b.cosine.lower), upper: Math.max(a.cosine.upper, b.cosine.upper) } };
}

interface PositiveParts { readonly logarithm: Range; readonly psi: Range; readonly psiPrime: Range }
/** Shift the complete interval by the same integer. No monotonicity of Gamma is assumed. */
function positiveParts(input: MathInterval): PositiveParts {
  const shifts = Math.max(0, Math.ceil(32-input.lower));
  const shifted = shifts === 0 ? input : add(input, point(shifts));
  const inverse = divide(ONE, shifted), inverseSquared = square(inverse);
  let logarithm = add(subtract(multiply(subtract(shifted, HALF), log(shifted)), shifted), HALF_LOG_TWO_PI);
  let psi = subtract(log(shifted), multiply(HALF, inverse));
  let psiPrime = add(inverse, multiply(HALF, inverseSquared));
  let power = inverse;
  // Nine coefficients are exactly representable integers in binary64. The ninth
  // term is not added: its sign and magnitude bound the omitted tail for x>0.
  for (let index = 0; index < 9; index++) {
    const [numerator, denominator] = STIRLING_COEFFICIENTS[index];
    const coefficient = divide(point(Number(numerator)), point(Number(denominator)));
    const term = multiply(coefficient, power), order = 2*index+1;
    const first = negate(multiply(point(order), multiply(term, inverse)));
    const second = multiply(point(order*(order+1)), multiply(term, inverseSquared));
    const remainder = (value: Range): Range => value === null ? null
      : { lower: Math.min(0, value.lower), upper: Math.max(0, value.upper) };
    logarithm = add(logarithm, index === 8 ? remainder(term) : term);
    psi = add(psi, index === 8 ? remainder(first) : first);
    psiPrime = add(psiPrime, index === 8 ? remainder(second) : second);
    power = multiply(power, inverseSquared);
  }
  // Gamma(x+n) = Gamma(x)*product(x+k); psi recurs with 1/(x+k).
  for (let index = 0; index < shifts; index++) {
    const shiftedInput = index === 0 ? input : add(input, point(index));
    const reciprocal = divide(ONE, shiftedInput);
    logarithm = subtract(logarithm, log(shiftedInput));
    psi = subtract(psi, reciprocal);
    psiPrime = add(psiPrime, square(reciprocal));
  }
  return { logarithm, psi, psiPrime };
}

/** Expose the logarithm for positive Beta without overflowing intermediate Gamma values. */
export function logGammaPositiveRange(input: MathInterval): Range {
  if (!Number.isFinite(input.lower) || !Number.isFinite(input.upper) || input.lower <= 0
    || input.lower > input.upper || input.upper > 20_000) return null;
  return positiveParts(input).logarithm;
}

export interface GammaFunctionRanges { readonly value: Range; readonly first: Range; readonly second: Range }
const UNKNOWN: GammaFunctionRanges = { value: null, first: null, second: null };

export function gammaFunctionRanges(input: MathInterval): GammaFunctionRanges {
  if (!Number.isFinite(input.lower) || !Number.isFinite(input.upper) || input.lower > input.upper
    || input.lower < -19_999 || input.upper > 20_000) return UNKNOWN;
  // This condition uses the original endpoints; outward arithmetic cannot make
  // a nonpositive integer disappear from a cell that contains it.
  if (input.lower <= 0 && Math.ceil(input.lower) <= Math.floor(Math.min(input.upper, 0))) return UNKNOWN;
  let value: Range, psi: Range, psiPrime: Range;
  if (input.lower > 0) {
    const positive = positiveParts(input);
    value = exp(positive.logarithm); psi = positive.psi; psiPrime = positive.psiPrime;
  } else {
    const reflected = subtract(ONE, input);
    if (reflected === null) return UNKNOWN;
    const positive = positiveParts(reflected);
    const { sine, cosine } = gammaReflectionTrig(input);
    value = divide(multiply(PI, exp(negate(positive.logarithm))), sine);
    psi = subtract(positive.psi, multiply(PI, divide(cosine, sine)));
    psiPrime = subtract(divide(square(PI), square(sine)), positive.psiPrime);
  }
  if (value === null || !Number.isFinite(value.lower) || !Number.isFinite(value.upper)
    || value.lower <= 0 && value.upper >= 0) return UNKNOWN;
  return { value, first: multiply(value, psi), second: multiply(value, add(square(psi), psiPrime)) };
}

export function gammaFunctionSample(input: number): number {
  const range = gammaFunctionRanges(point(input)).value;
  return range === null ? NaN : range.lower+(range.upper-range.lower)/2;
}
