/** Directed fixed-point arithmetic for cancellation in the second-kind Bessel series. */
export const BESSEL_FIXED_SCALE = 10n ** 240n;
export interface BesselFixedRange { readonly lower: bigint; readonly upper: bigint }
export const FIXED_ZERO: BesselFixedRange = { lower: 0n, upper: 0n };
export const FIXED_ONE: BesselFixedRange = { lower: BESSEL_FIXED_SCALE, upper: BESSEL_FIXED_SCALE };
export function floorQuotient(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('Positive denominator required');
  return a / b - (a % b < 0n ? 1n : 0n);
}
export const ceilQuotient = (a: bigint, b: bigint): bigint => -floorQuotient(-a, b);
export function fixedRational(numerator: bigint, denominator = 1n): BesselFixedRange {
  if (denominator < 0n) return fixedRational(-numerator, -denominator);
  const scaled = numerator * BESSEL_FIXED_SCALE;
  return { lower: floorQuotient(scaled, denominator), upper: ceilQuotient(scaled, denominator) };
}
export const fixedAdd = (a: BesselFixedRange, b: BesselFixedRange): BesselFixedRange =>
  ({ lower: a.lower + b.lower, upper: a.upper + b.upper });
export const fixedNegate = (a: BesselFixedRange): BesselFixedRange => ({ lower: -a.upper, upper: -a.lower });
export const fixedSubtract = (a: BesselFixedRange, b: BesselFixedRange): BesselFixedRange => fixedAdd(a, fixedNegate(b));
export function fixedTimesRational(a: BesselFixedRange, numerator: bigint, denominator = 1n): BesselFixedRange {
  if (denominator <= 0n) throw new RangeError('Positive denominator required');
  const lower = (numerator < 0n ? a.upper : a.lower) * numerator;
  const upper = (numerator < 0n ? a.lower : a.upper) * numerator;
  return { lower: floorQuotient(lower, denominator), upper: ceilQuotient(upper, denominator) };
}
export function fixedMultiply(a: BesselFixedRange, b: BesselFixedRange): BesselFixedRange {
  const values = [a.lower*b.lower, a.lower*b.upper, a.upper*b.lower, a.upper*b.upper];
  const lower = values.reduce((x,y) => x<y?x:y), upper = values.reduce((x,y) => x>y?x:y);
  return { lower: floorQuotient(lower,BESSEL_FIXED_SCALE), upper: ceilQuotient(upper,BESSEL_FIXED_SCALE) };
}
export function fixedDivide(a: BesselFixedRange, b: BesselFixedRange): BesselFixedRange {
  if (b.lower <= 0n && b.upper >= 0n) throw new RangeError('Divisor must exclude zero');
  const values = [fixedRational(a.lower,b.lower),fixedRational(a.lower,b.upper),
    fixedRational(a.upper,b.lower),fixedRational(a.upper,b.upper)];
  return { lower: values.map(x=>x.lower).reduce((x,y)=>x<y?x:y),
    upper: values.map(x=>x.upper).reduce((x,y)=>x>y?x:y) };
}
export const fixedWiden = (value: BesselFixedRange, error: bigint): BesselFixedRange =>
  ({ lower: value.lower-error, upper: value.upper+error });
