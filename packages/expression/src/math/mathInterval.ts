/** Conservative scalar ranges for domain subdivision; not a universal function-error certificate. */
export interface MathInterval { readonly lower: number; readonly upper: number }
export type IntervalValue =
  | { readonly status: 'range'; readonly interval: MathInterval }
  | { readonly status: 'outside-domain' }
  | { readonly status: 'split'; readonly reason: 'domain-boundary' | 'pole' | 'unknown' };

const bits = new DataView(new ArrayBuffer(8));
/** Directed neighbouring doubles, used to enclose rounding in basic arithmetic. */
export function nextFloat(value: number, direction: -1 | 1): number {
  if (Number.isNaN(value) || value === (direction === 1 ? Infinity : -Infinity)) return value;
  if (value === 0) return direction * Number.MIN_VALUE;
  bits.setFloat64(0, value, false);
  const encoded = bits.getBigUint64(0, false);
  bits.setBigUint64(0, encoded + ((value > 0) === (direction > 0) ? 1n : -1n), false);
  return bits.getFloat64(0, false);
}

function range(lower: number, upper: number): IntervalValue {
  if (Number.isNaN(lower) || Number.isNaN(upper) || lower > upper) return { status: 'split', reason: 'unknown' };
  return { status: 'range', interval: { lower, upper } };
}
function outward(lower: number, upper: number): IntervalValue {
  return range(nextFloat(lower, -1), nextFloat(upper, 1));
}
export function intervalConstant(value: number): IntervalValue {
  return Number.isFinite(value) ? range(value, value) : { status: 'outside-domain' };
}
export function intervalAdd(a: MathInterval, b: MathInterval): IntervalValue {
  // Adding the exact real number zero introduces no floating-point rounding.
  // Keep an already certified enclosure instead of inventing a subnormal error.
  if (a.lower === 0 && a.upper === 0) return range(b.lower, b.upper);
  if (b.lower === 0 && b.upper === 0) return range(a.lower, a.upper);
  return outward(a.lower + b.lower, a.upper + b.upper);
}
export function intervalSubtract(a: MathInterval, b: MathInterval): IntervalValue {
  if (b.lower === 0 && b.upper === 0) return range(a.lower, a.upper);
  if (a.lower === 0 && a.upper === 0) return range(-b.upper, -b.lower);
  return outward(a.lower - b.upper, a.upper - b.lower);
}
export function intervalMultiply(a: MathInterval, b: MathInterval): IntervalValue {
  const values = [a.lower * b.lower, a.lower * b.upper, a.upper * b.lower, a.upper * b.upper];
  if (values.some(Number.isNaN)) return { status: 'split', reason: 'unknown' };
  return outward(Math.min(...values), Math.max(...values));
}
export function intervalDivide(a: MathInterval, b: MathInterval): IntervalValue {
  if (b.lower <= 0 && b.upper >= 0) {
    return b.lower === 0 && b.upper === 0 ? { status: 'outside-domain' } : { status: 'split', reason: 'pole' };
  }
  const inverse = outward(1 / b.upper, 1 / b.lower);
  return inverse.status === 'range' ? intervalMultiply(a, inverse.interval) : inverse;
}
export function intervalSquare(value: MathInterval): IntervalValue {
  const lower = value.lower <= 0 && value.upper >= 0 ? 0 : Math.min(value.lower ** 2, value.upper ** 2);
  const upper = Math.max(value.lower ** 2, value.upper ** 2);
  const result = outward(lower, upper);
  return result.status === 'range' ? range(Math.max(0, result.interval.lower), result.interval.upper) : result;
}
export function intervalSqrt(value: MathInterval): IntervalValue {
  if (value.upper < 0) return { status: 'outside-domain' };
  if (value.lower < 0) return { status: 'split', reason: 'domain-boundary' };
  function bound(input: number, direction: -1 | 1): number | null {
    if (input === 0 || input === Infinity) return input;
    let candidate = Math.sqrt(input);
    for (let index = 0; index < 64; index += 1) {
      const squared = outward(candidate * candidate, candidate * candidate);
      if (squared.status !== 'range') return null;
      if (direction === -1 ? squared.interval.upper <= input : squared.interval.lower >= input) return candidate;
      candidate = Math.max(0, nextFloat(candidate, direction));
    }
    return null;
  }
  const lower = bound(value.lower, -1), upper = bound(value.upper, 1);
  return lower === null || upper === null ? { status: 'split', reason: 'unknown' } : range(lower, upper);
}
export function intervalAbsolute(value: MathInterval): IntervalValue {
  return value.lower >= 0 ? range(value.lower, value.upper) : value.upper <= 0 ? range(-value.upper, -value.lower)
    : range(0, Math.max(-value.lower, value.upper));
}

/** Transcendentals need a documented error bound before they can certify continuity/ranges. */
export function intervalLogDomain(value: MathInterval): IntervalValue {
  if (value.upper <= 0) return { status: 'outside-domain' };
  if (value.lower <= 0) return { status: 'split', reason: 'domain-boundary' };
  // JS Math.log is not specified to be correctly rounded. Keep a wide valid enclosure instead
  // of claiming a one-ulp error bound; positivity still proves continuity of log on this interval.
  return range(-Infinity, Infinity);
}

export function intervalOutsideBox(value: readonly [MathInterval, MathInterval, MathInterval],
  lower: readonly [number, number, number], upper: readonly [number, number, number]): boolean {
  return value.some((interval, axis) => interval.upper < lower[axis] || interval.lower > upper[axis]);
}
