/** Natural logarithm enclosures from an atanh series, with explicit tail and directed rounding. */
import { intervalAdd, intervalSubtract, intervalMultiply, intervalDivide,
  type MathInterval, type IntervalValue } from './mathInterval.js';

const ONE: MathInterval = { lower: 1, upper: 1 }, TWO: MathInterval = { lower: 2, upper: 2 };
const LN2: MathInterval = { lower: 0.6931471805599453, upper: 0.6931471805599454 };
const LN10: MathInterval = { lower: 2.3025850929940455, upper: 2.302585092994046 };
const scratch = new DataView(new ArrayBuffer(8));
function unpack(value: IntervalValue): MathInterval | null { return value.status === 'range' ? value.interval : null; }
function multiply(a: MathInterval, b: MathInterval): MathInterval | null { return unpack(intervalMultiply(a, b)); }
function naturalPoint(value: number): MathInterval | null {
  if (value === Infinity) return { lower: Infinity, upper: Infinity };
  if (!(value > 0) || !Number.isFinite(value)) return null;
  if (value === 1) return { lower: 0, upper: 0 };
  scratch.setFloat64(0, value, false);
  let exponent = ((scratch.getUint32(0, false) >>> 20) & 0x7ff)-1023;
  if (exponent === -1023) {
    scratch.setFloat64(0, value*2**52, false);
    exponent = ((scratch.getUint32(0, false) >>> 20) & 0x7ff)-1023-52;
  }
  // Scaling a finite binary number by its binary exponent is exact, including subnormals.
  const mantissa = value/2**exponent;
  if (!(mantissa >= 1 && mantissa < 2)) return null;
  const exponentTerm = multiply({ lower: exponent, upper: exponent }, LN2);
  if (exponentTerm === null) return null;
  if (mantissa === 1) return exponentTerm;
  const numerator = unpack(intervalSubtract({ lower: mantissa, upper: mantissa }, ONE));
  const denominator = unpack(intervalAdd({ lower: mantissa, upper: mantissa }, ONE));
  const ratio = numerator === null || denominator === null ? null : unpack(intervalDivide(numerator, denominator));
  if (ratio === null || ratio.lower < 0 || ratio.upper >= 1) return null;
  const squared = multiply(ratio, ratio); if (squared === null) return null;
  let term = ratio, sum: MathInterval = { lower: 0, upper: 0 };
  for (let index = 0; index < 25; index++) {
    const divisor = 2*index+1;
    const increment = unpack(intervalDivide(term, { lower: divisor, upper: divisor }));
    const nextSum = increment === null ? null : unpack(intervalAdd(sum, increment));
    const nextTerm = multiply(term, squared);
    if (nextSum === null || nextTerm === null) return null;
    sum = nextSum; term = nextTerm;
  }
  // ln(m)=2*(r+r^3/3+...+r^49/49)+R; 0<=R<=2*r^51/(51*(1-r²)).
  const tailDenominator = unpack(intervalSubtract(ONE, squared));
  const scaledDenominator = tailDenominator === null ? null : multiply({ lower: 51, upper: 51 }, tailDenominator);
  const tail = scaledDenominator === null ? null : unpack(intervalDivide(term, scaledDenominator));
  const withTail = tail === null ? null : unpack(intervalAdd(sum, { lower: 0, upper: tail.upper }));
  const twice = withTail === null ? null : multiply(TWO, withTail);
  return twice === null ? null : unpack(intervalAdd(exponentTerm, twice));
}

/** The positive portion can start arbitrarily close to zero; never replace it by Number.MIN_VALUE. */
export function logarithmicPositiveRange(value: MathInterval, base: 'e' | 'two' | 'ten'): MathInterval | null {
  if (Number.isNaN(value.lower) || Number.isNaN(value.upper) || value.lower > value.upper || value.upper <= 0) return null;
  const lower = value.lower <= 0 ? { lower: -Infinity, upper: -Infinity } : naturalPoint(value.lower);
  const upper = naturalPoint(value.upper);
  if (lower === null || upper === null) return null;
  const natural = { lower: lower.lower, upper: upper.upper };
  return base === 'e' ? natural : unpack(intervalDivide(natural, base === 'two' ? LN2 : LN10));
}
