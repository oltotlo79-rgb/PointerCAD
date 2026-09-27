/** Real Gamma values. DLMF 5.2/5.5: original rational poles and reflection. */
import Decimal from 'decimal.js';
import type { ExactRational } from './exactRational.js';
import { logGammaPositive } from './gammaBetaNumeric.js';
import { MathInputProblem } from './mathInputContract.js';

const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_EVEN });
const PI = D.acos(-1);
const decimal = (numerator: bigint, denominator: bigint): Decimal =>
  new D(numerator.toString()).div(denominator.toString());

/** Reduce modulo two in exact integers before computing sin(pi*x).
 * An input -1+1e-100 must not become exactly -1 during decimal conversion.
 */
function reflectedSine(value: ExactRational): Decimal {
  let quotient = value.numerator / value.denominator;
  let remainder = value.numerator % value.denominator;
  if (2n * remainder > value.denominator) {
    remainder -= value.denominator; quotient += 1n;
  } else if (2n * remainder < -value.denominator) {
    remainder += value.denominator; quotient -= 1n;
  }
  const sine = PI.mul(decimal(remainder, value.denominator)).sin();
  return quotient % 2n === 0n ? sine : sine.neg();
}

export function gammaFunctionDecimal(argument: ExactRational, check: () => void): string {
  check();
  const { numerator, denominator } = argument;
  if (denominator <= 0n || numerator.toString(2).length > 8193 || denominator.toString(2).length > 8192) {
    throw new MathInputProblem('budget', 'Gamma関数の引数を正確に保持できません。');
  }
  if (numerator <= 0n && numerator % denominator === 0n) {
    throw new MathInputProblem('domain', 'Gamma関数には0と負の整数を指定できません。');
  }
  if (numerator > 20_000n * denominator || numerator < -19_999n * denominator) {
    throw new MathInputProblem('budget', 'Gamma関数の引数が対応する範囲を超えています。');
  }
  let result: Decimal;
  if (numerator > 0n) {
    result = logGammaPositive(decimal(numerator, denominator), check).exp();
  } else {
    const sine = reflectedSine(argument);
    if (sine.isZero()) throw new MathInputProblem('budget', 'Gamma関数の極からの距離を確定できません。');
    const reflected = logGammaPositive(decimal(denominator-numerator, denominator), check);
    result = PI.div(sine).mul(reflected.neg().exp());
  }
  check();
  if (!result.isFinite() || result.isZero()) {
    throw new MathInputProblem('budget', 'Gamma関数の値を必要な桁数で確定できません。');
  }
  return result.toSignificantDigits(40).toString();
}
