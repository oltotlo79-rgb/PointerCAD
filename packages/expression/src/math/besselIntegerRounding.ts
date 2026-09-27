/** Exact decimal rounding of the rational endpoints of a Bessel series. */
import type { ExactRational } from './exactRational.js';

export function roundBesselRational(value: ExactRational): string {
  if (value.denominator <= 0n) throw new RangeError('Positive denominator required');
  if (value.numerator === 0n) return '0';
  const negative = value.numerator < 0n;
  const numerator = negative ? -value.numerator : value.numerator;
  let exponent = numerator.toString().length - value.denominator.toString().length;
  const belowPower = exponent >= 0
    ? numerator < value.denominator * 10n ** BigInt(exponent)
    : numerator * 10n ** BigInt(-exponent) < value.denominator;
  if (belowPower) exponent -= 1;
  const shift = 39 - exponent;
  const scaled = shift >= 0 ? numerator * 10n ** BigInt(shift) : numerator;
  const divisor = shift >= 0 ? value.denominator : value.denominator * 10n ** BigInt(-shift);
  let rounded = scaled / divisor;
  const twiceRemainder = 2n * (scaled % divisor);
  if (twiceRemainder > divisor || (twiceRemainder === divisor && rounded % 2n !== 0n)) rounded += 1n;
  let scale = -shift;
  while (rounded % 10n === 0n) { rounded /= 10n; scale += 1; }
  return `${negative ? '-' : ''}${rounded.toString()}e${String(scale)}`;
}
