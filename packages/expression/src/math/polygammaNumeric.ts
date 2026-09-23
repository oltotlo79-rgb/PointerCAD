/** Real psi and its derivatives, DLMF 5.15.5/6/9. No finite differences. */
import Decimal from 'decimal.js';
import type { ExactRational } from './exactRational.js';
import { MathInputProblem } from './mathInputContract.js';
import { STIRLING_COEFFICIENTS } from './gammaStirlingCoefficients.js';
import { MAX_POLYGAMMA_ORDER, risingInteger, cotangentDerivativeCoefficients } from './polygammaCoefficients.js';

const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_EVEN });
const PI = D.acos(-1), ONE = new D(1);
const number = (value: bigint): Decimal => new D(value.toString());
interface Approximation { readonly value: Decimal; readonly error: Decimal }
function budget(): never {
  throw new MathInputProblem('budget', 'Gamma関数の微分値を必要な桁数で確定できません。');
}

/** The next signed Stirling term bounds the positive-real remainder.
 * See the Laplace-kernel derivation in docs/standards/math-runtime.md.
 */
function positive(order: number, input: Decimal, check: () => void): Approximation {
  const sign = order % 2 === 0 ? -1 : 1, factorial = number(risingInteger(1, order));
  let z = input, correction = new D(0), scale = new D(0);
  for (let index = 0; z.lt(128); index++) {
    if ((index & 15) === 0) check();
    const term = factorial.div(z.pow(order+1)).mul(sign);
    correction = correction.add(term); scale = scale.add(term.abs()); z = z.add(1);
  }
  const inverse = ONE.div(z), square = inverse.mul(inverse);
  let value = order === 0 ? z.ln().sub(inverse.div(2))
    : number(risingInteger(1, order-1)).mul(inverse.pow(order)).mul(sign)
      .add(factorial.mul(inverse.pow(order+1)).mul(sign).div(2));
  scale = scale.add(value.abs()); value = value.add(correction);
  let power = inverse.pow(order+2);
  for (let index = 0; index < STIRLING_COEFFICIENTS.length; index++) {
    if ((index & 7) === 0) check();
    const [numerator, denominator] = STIRLING_COEFFICIENTS[index];
    const coefficient = new D(numerator).mul(number(risingInteger(2*index+1, order+1))).div(denominator);
    const term = coefficient.mul(power).mul(sign);
    if (term.abs().lte(value.abs().mul('1e-60'))) {
      return { value, error: term.abs().add(scale.mul('1e-70')) };
    }
    value = value.add(term); scale = scale.add(term.abs()); power = power.mul(square);
  }
  return budget();
}

/** cot(pi*x) has period one. Preserve the exact distance to an integer and
 * the exact zero at a half-integer before rounding the argument to Decimal.
 */
function cotangent(input: ExactRational): Decimal {
  const denominator = input.denominator;
  let remainder = input.numerator % denominator;
  if (2n*remainder > denominator) remainder -= denominator;
  if (2n*remainder < -denominator) remainder += denominator;
  if (2n*(remainder < 0n ? -remainder : remainder) === denominator) return new D(0);
  const angle = PI.mul(number(remainder).div(number(denominator)));
  const sine = angle.sin();
  if (sine.isZero()) return budget();
  return angle.cos().div(sine);
}

export function polygammaDecimal(order: number, input: ExactRational, check: () => void): string {
  check();
  if (!Number.isInteger(order) || order < 0 || order > MAX_POLYGAMMA_ORDER) {
    throw new MathInputProblem('domain', 'Gamma関数の微分の次数は0から17までの整数で指定してください。');
  }
  const { numerator, denominator } = input;
  if (denominator <= 0n || numerator.toString(2).length > 8193 || denominator.toString(2).length > 8192) return budget();
  if (numerator <= 0n && numerator % denominator === 0n) {
    throw new MathInputProblem('domain', 'Gamma関数の微分には0と負の整数を指定できません。');
  }
  if (numerator < -19_999n*denominator || numerator > 20_000n*denominator) return budget();
  let result: Approximation;
  if (numerator > 0n) result = positive(order, number(numerator).div(number(denominator)), check);
  else {
    const reflected = positive(order, number(denominator-numerator).div(number(denominator)), check);
    const cot = cotangent(input), coefficients = cotangentDerivativeCoefficients(order);
    let polynomial = new D(0);
    for (let index = coefficients.length-1; index >= 0; index--) polynomial = polynomial.mul(cot).add(number(coefficients[index]));
    const correction = PI.pow(order+1).mul(polynomial);
    const value = reflected.value.mul(order % 2 === 0 ? 1 : -1).sub(correction);
    result = { value, error: reflected.error.add(correction.abs().mul('1e-70')) };
  }
  check();
  if (!result.value.isFinite() || result.value.isZero() || result.error.gt(result.value.abs().mul('1e-45'))) return budget();
  return result.value.toSignificantDigits(40).toString();
}
