/** Integer-order J/I, DLMF 10.2.2 and 10.25.2. All rounding and tails are enclosed. */
import type { ExactRational } from './exactRational.js';
import { MathInputProblem } from './mathInputContract.js';
import { roundBesselRational } from './besselIntegerRounding.js';

export type IntegerBesselKind = 'J' | 'I';
export interface IntegerBesselBounds {
  readonly lower: ExactRational;
  readonly upper: ExactRational;
  readonly decimal: string;
  readonly terms: number;
}
// These are work limits of this kernel, not domain restrictions of Bessel functions.
export const BESSEL_INTEGER_ORDER_LIMIT = 128;
export const BESSEL_INTEGER_ARGUMENT_LIMIT = 128;
const SCALE = 10n ** 192n;
const RELATIVE_GUARD = 10n ** 72n;
const ceilPositive = (a: bigint, b: bigint) => (a + b - 1n) / b;

function validate(kind: IntegerBesselKind, order: number, input: ExactRational): void {
  if (kind !== 'J' && kind !== 'I') throw new MathInputProblem('unsupported', 'Bessel関数の種類に対応していません。');
  if (!Number.isSafeInteger(order)) throw new MathInputProblem('unsupported', 'この計算には整数の次数が必要です。');
  // Two additional orders are reserved for second derivatives at the public limit.
  if (Math.abs(order) > BESSEL_INTEGER_ORDER_LIMIT + 2) throw new MathInputProblem('budget', 'Bessel関数の次数が計算範囲を超えています。');
  const magnitude = input.numerator < 0n ? -input.numerator : input.numerator;
  if (input.denominator <= 0n || magnitude.toString(2).length > 8192 || input.denominator.toString(2).length > 8192) {
    throw new MathInputProblem('budget', 'Bessel関数の引数を正確に保持できません。');
  }
  if (magnitude > BigInt(BESSEL_INTEGER_ARGUMENT_LIMIT) * input.denominator) {
    throw new MathInputProblem('budget', 'Bessel関数の引数の絶対値は128以下にしてください。');
  }
}

function initialFactor(order: number, numerator: bigint, denominator: bigint, check: () => void): ExactRational {
  // Keep (x/2)^n/n! separate: even x^n below 10^-192 must not disappear.
  let p = 1n, q = 1n;
  for (let index = 1; index <= order; index += 1) {
    check(); p *= numerator; q *= 2n * denominator * BigInt(index);
  }
  return { numerator: p, denominator: q };
}

export function integerBesselSeries(kind: IntegerBesselKind, order: number, input: ExactRational,
  check: () => void): IntegerBesselBounds {
  check(); validate(kind, order, input);
  const n = Math.abs(order), p = input.numerator < 0n ? -input.numerator : input.numerator;
  if (p === 0n) {
    const value = { numerator: n === 0 ? 1n : 0n, denominator: 1n };
    return { lower: value, upper: value, decimal: n === 0 ? '1' : '0', terms: 0 };
  }
  const negative = n % 2 === 1 && ((input.numerator < 0n) !== (kind === 'J' && order < 0));
  const factor = initialFactor(n, p, input.denominator, check);
  const square = p * p, fourQSquared = 4n * input.denominator * input.denominator;
  let termLower = SCALE, termUpper = SCALE, sumLower = SCALE, sumUpper = SCALE;
  for (let k = 0; k < 1024; k += 1) {
    check();
    const nextDenominator = fourQSquared * BigInt(k + 1) * BigInt(n + k + 1);
    // All subsequent ratios decrease. Geometric majorant includes EVERY omitted term.
    if (2n * square <= nextDenominator) {
      const tail = ceilPositive(termUpper * square, nextDenominator - square);
      const low = sumLower - tail, high = sumUpper + tail;
      const magnitude = low > 0n ? low : high < 0n ? -high : 0n;
      if (magnitude > 0n && (high - low) * RELATIVE_GUARD <= magnitude) {
        const denominator = SCALE * factor.denominator;
        const lower = { numerator: (negative ? -high : low) * factor.numerator, denominator };
        const upper = { numerator: (negative ? -low : high) * factor.numerator, denominator };
        const decimal = roundBesselRational(lower);
        if (decimal === roundBesselRational(upper)) {
          check(); return { lower, upper, decimal, terms: k + 1 };
        }
      }
    }
    termLower = termLower * square / nextDenominator;
    termUpper = ceilPositive(termUpper * square, nextDenominator);
    if (kind === 'J' && (k + 1) % 2 === 1) {
      sumLower -= termUpper; sumUpper -= termLower;
    } else { sumLower += termLower; sumUpper += termUpper; }
  }
  throw new MathInputProblem('budget', 'Bessel関数の値を必要な桁数で確定できません。');
}
