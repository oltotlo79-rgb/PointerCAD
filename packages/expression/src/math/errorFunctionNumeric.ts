/** Real error functions share the normal distribution's positive central series and tail.
 * NIST DLMF 7.6.2 / 7.9.1. Keep the tail itself, never subtract rounded probabilities.
 */
import Decimal from 'decimal.js';
import { MathInputProblem } from './mathInputContract.js';
import type { ExactRational } from './exactRational.js';
import { positiveNormal } from './normalDistributionNumeric.js';

const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_EVEN });
const SQRT_TWO = new D(2).sqrt();
export function errorFunctionDecimal(id: 'erf' | 'erfc', argument: ExactRational, check: () => void): string {
  check();
  if (argument.numerator === 0n) return id === 'erf' ? '0' : '1';
  const x = new D(argument.numerator.toString()).div(argument.denominator.toString());
  const parts = positiveNormal(x.abs().mul(SQRT_TWO), check);
  let result = id === 'erfc' ? parts.tail.mul(2)
    : parts.center === null ? new D(1).sub(parts.tail.mul(2)) : parts.center.mul(2);
  if (x.isNegative()) result = id === 'erf' ? result.neg() : new D(2).sub(result);
  if (!result.isFinite() || result.isZero()) {
    throw new MathInputProblem('budget', '誤差関数の値を必要な桁数で確定できません。');
  }
  check();
  // Keep guard digits inside the kernel; the public numerical result has 40
  // significant digits, just like the other high-precision distributions.
  return result.toSignificantDigits(40).toString();
}
