/** Finite real values of a rational expression, including disjoint ranges around a pole. */
import { nextFloat, intervalAdd, intervalSubtract, intervalMultiply, type MathInterval, type IntervalValue } from './mathInterval.js';

export interface IntervalUnion {
  readonly ranges: readonly MathInterval[];
  /** Defined throughout the parameter interval. False also covers unproven continuity. */
  readonly continuous: boolean;
}
const WHOLE: MathInterval = { lower: -Infinity, upper: Infinity };
export function intervalUnion(lower: number, upper = lower): IntervalUnion {
  if (Number.isNaN(lower) || Number.isNaN(upper) || lower > upper) return { ranges: [WHOLE], continuous: false };
  return { ranges: [{ lower, upper }], continuous: true };
}
function normalize(ranges: readonly MathInterval[], continuous: boolean): IntervalUnion {
  // Empty and singleton ranges need no sorting or merging; retain the independent array.
  if (ranges.length < 2) return { ranges: [...ranges], continuous };
  const sorted = [...ranges].sort((a, b) => a.lower - b.lower);
  const merged: MathInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous && interval.lower <= previous.upper) {
      merged[merged.length - 1] = { lower: previous.lower, upper: Math.max(previous.upper, interval.upper) };
    } else merged.push(interval);
  }
  // A hull is conservative if intermediate expressions create too many branches.
  if (merged.length > 8) {
    const first = merged[0], last = merged.at(-1);
    return { ranges: first && last ? [{ lower: first.lower, upper: last.upper }] : [], continuous };
  }
  return { ranges: merged, continuous };
}
export function unionCombine(a: IntervalUnion, b: IntervalUnion,
  operation: (a: MathInterval, b: MathInterval) => IntervalValue): IntervalUnion {
  const ranges: MathInterval[] = [];
  let continuous = a.continuous && b.continuous;
  for (const left of a.ranges) for (const right of b.ranges) {
    const result = operation(left, right);
    if (result.status === 'range') ranges.push(result.interval);
    else if (result.status === 'split') { ranges.push(WHOLE); continuous = false; }
    else continuous = false;
  }
  return normalize(ranges, continuous);
}
export function unionAdd(a: IntervalUnion, b: IntervalUnion): IntervalUnion { return unionCombine(a, b, intervalAdd); }
export function unionSubtract(a: IntervalUnion, b: IntervalUnion): IntervalUnion { return unionCombine(a, b, intervalSubtract); }
export function unionMultiply(a: IntervalUnion, b: IntervalUnion): IntervalUnion { return unionCombine(a, b, intervalMultiply); }

/** Apply a domain-aware operation without dropping the undefined parts of its input. */
export function unionMap(value: IntervalUnion, operation: (range: MathInterval) => IntervalValue): IntervalUnion {
  const ranges: MathInterval[] = [];
  let continuous = value.continuous;
  for (const input of value.ranges) {
    const result = operation(input);
    if (result.status === 'range') ranges.push(result.interval);
    else if (result.status === 'split') { ranges.push(WHOLE); continuous = false; }
    else continuous = false;
  }
  return normalize(ranges, continuous);
}

/** A partial domain may have a useful range while remaining discontinuous on the input cell. */
export function unionFlatMap(value: IntervalUnion, operation: (range: MathInterval) => IntervalUnion): IntervalUnion {
  const ranges: MathInterval[] = [];
  let continuous = value.continuous;
  for (const input of value.ranges) {
    const output = operation(input);
    ranges.push(...output.ranges);
    continuous = continuous && output.continuous;
  }
  return normalize(ranges, continuous);
}

export function unionReciprocal(value: IntervalUnion): IntervalUnion {
  const ranges: MathInterval[] = [];
  let continuous = value.continuous;
  for (const interval of value.ranges) {
    if (interval.lower <= 0 && interval.upper >= 0) {
      continuous = false;
      if (interval.lower < 0) ranges.push({ lower: -Infinity, upper: nextFloat(1 / interval.lower, 1) });
      if (interval.upper > 0) ranges.push({ lower: nextFloat(1 / interval.upper, -1), upper: Infinity });
    } else ranges.push({ lower: nextFloat(1 / interval.upper, -1), upper: nextFloat(1 / interval.lower, 1) });
  }
  return normalize(ranges, continuous);
}
export function unionDivide(a: IntervalUnion, b: IntervalUnion): IntervalUnion {
  return unionMultiply(a, unionReciprocal(b));
}
/** May exclude a whole parameter interval even when its middle is undefined, e.g. 1/x near zero. */
export function unionOutsideBounds(values: readonly [IntervalUnion, IntervalUnion, IntervalUnion],
  min: readonly [number, number, number], max: readonly [number, number, number]): boolean {
  return values.some((value, axis) => value.ranges.every(range => range.upper < min[axis] || range.lower > max[axis]));
}
