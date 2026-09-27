/** DLMF 7.6.1 with a geometric remainder.
 * All components include directed arithmetic error. A small component is never
 * rounded to zero merely because the other component is much larger.
 */
import Decimal from 'decimal.js';
import { MathInputProblem } from './mathInputContract.js';
import type { ExactRational } from './exactRational.js';
import { besselConstants } from './besselConstants.js';
import { roundBesselRational } from './besselIntegerRounding.js';
import { ellipticSqrt, ellipticSquare } from './ellipticFixed.js';
import { BESSEL_FIXED_SCALE as S, FIXED_ZERO, FIXED_ONE,
  fixedRational, fixedAdd, fixedSubtract, fixedMultiply, fixedDivide,
  fixedTimesRational, fixedNegate, fixedWiden, ceilQuotient,
  type BesselFixedRange as Range } from './besselFixedRange.js';

type Pair = readonly [Range, Range];
export interface ComplexErrorValue {
  readonly real: { readonly bounds: Range; readonly decimal: string };
  readonly imaginary: { readonly bounds: Range; readonly decimal: string };
  readonly terms: number;
}
const plus = (a: Pair, b: Pair): Pair => [fixedAdd(a[0], b[0]), fixedAdd(a[1], b[1])];
const times = (a: Pair, b: Pair): Pair => [
  fixedSubtract(fixedMultiply(a[0], b[0]), fixedMultiply(a[1], b[1])),
  fixedAdd(fixedMultiply(a[0], b[1]), fixedMultiply(a[1], b[0])),
];
const scale = (a: Pair, numerator: bigint, denominator = 1n): Pair =>
  [fixedTimesRational(a[0], numerator, denominator), fixedTimesRational(a[1], numerator, denominator)];
const magnitude = (a: Range): bigint => -a.lower > a.upper ? -a.lower : a.upper;
function rounded(bounds: Range): string | null {
  const lower = roundBesselRational({ numerator: bounds.lower, denominator: S });
  const upper = roundBesselRational({ numerator: bounds.upper, denominator: S });
  return lower === upper ? new Decimal(lower).toString() : null;
}

export function validateComplexErrorArgument(real: ExactRational, imaginary: ExactRational): void {
  for (const value of [real, imaginary]) {
    if (value.denominator <= 0n) throw new MathInputProblem('domain', '複素数の成分を有限の数で指定してください。');
    if (value.numerator.toString(2).length > 8193 || value.denominator.toString(2).length > 8192
      || value.numerator > 8n * value.denominator || value.numerator < -8n * value.denominator) {
      throw new MathInputProblem('budget', '複素数の誤差関数は実部と虚部がそれぞれ-8から8までです。');
    }
  }
}

export function complexErrorFunctionValue(id: 'erf' | 'erfc', real: ExactRational,
  imaginary: ExactRational, check: () => void): ComplexErrorValue {
  check();
  validateComplexErrorArgument(real, imaginary);
  const z: Pair = [fixedRational(real.numerator, real.denominator),
    fixedRational(imaginary.numerator, imaginary.denominator)];
  const minusSquare = scale(times(z, z), -1n);
  const radiusSquared = fixedAdd(ellipticSquare(z[0]), ellipticSquare(z[1])).upper;
  const factor = fixedDivide(fixedRational(2n), ellipticSqrt(besselConstants(check).pi, check));
  let power = z, sum: Pair = [FIXED_ZERO, FIXED_ZERO];
  for (let n = 0; n < 4096; n++) {
    check();
    sum = plus(sum, scale(power, 1n, BigInt(2 * n + 1)));
    const next = scale(times(power, minusSquare), 1n, BigInt(n + 1));
    const nextDenominator = BigInt(n + 2) * S - radiusSquared;
    if (nextDenominator > 0n) {
      // The ratio of successive omitted terms is <= |z|²/(n+2).
      // |Re(next)|+|Im(next)| bounds |next|, including rounding error.
      const error = ceilQuotient((magnitude(next[0]) + magnitude(next[1])) * BigInt(n + 2) * S,
        BigInt(2 * n + 3) * nextDenominator);
      // Exact axis zeros follow from the real coefficients and odd powers.
      const erfReal = real.numerator === 0n ? FIXED_ZERO : fixedMultiply(fixedWiden(sum[0], error), factor);
      const erfImaginary = imaginary.numerator === 0n ? FIXED_ZERO : fixedMultiply(fixedWiden(sum[1], error), factor);
      const bounds: Pair = id === 'erf' ? [erfReal, erfImaginary]
        : [fixedSubtract(FIXED_ONE, erfReal), fixedNegate(erfImaginary)];
      const a = rounded(bounds[0]), b = rounded(bounds[1]);
      if (a !== null && b !== null) {
        check();
        return { real: { bounds: bounds[0], decimal: a }, imaginary: { bounds: bounds[1], decimal: b }, terms: n + 1 };
      }
    }
    power = next;
  }
  throw new MathInputProblem('budget', '複素数の誤差関数を必要な桁数で確定できません。');
}
