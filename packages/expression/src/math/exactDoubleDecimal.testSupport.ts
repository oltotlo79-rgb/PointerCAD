import type Decimal from 'decimal.js';
import { exactDouble } from './exactDoubleInterval.js';

/** Keep each test's Decimal clone, precision and finite-endpoint diagnostic. */
export function exactDoubleDecimal(value: number, Constructor: Decimal.Constructor, finiteMessage: string): Decimal {
  const rational = exactDouble(value);
  if (rational === null) throw new Error(finiteMessage);
  return new Constructor(rational.numerator.toString()).div(rational.denominator.toString());
}
