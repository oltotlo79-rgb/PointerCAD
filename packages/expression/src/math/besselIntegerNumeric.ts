/** Public real integer-order numerical entry; original expression remains symbolic. */
import Decimal from 'decimal.js';
import type { ExactRational } from './exactRational.js';
import { MathInputProblem } from './mathInputContract.js';
import { BESSEL_INTEGER_ORDER_LIMIT, integerBesselSeries, type IntegerBesselKind } from './besselIntegerSeries.js';

export function integerBesselDecimal(kind: IntegerBesselKind, order: number, input: ExactRational,
  check: () => void): string {
  check();
  if (Math.abs(order) > BESSEL_INTEGER_ORDER_LIMIT) throw new MathInputProblem('budget', 'Bessel関数の次数の絶対値は128以下にしてください。');
  // Formatting only. The preceding rational endpoint test decides all forty digits.
  return new Decimal(integerBesselSeries(kind, order, input, check).decimal).toString();
}
