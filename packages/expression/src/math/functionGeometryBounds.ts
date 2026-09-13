/** Shared finite XYZ inputs and evaluation-error bounds for curves and surfaces. */
import { intervalSubtract, nextFloat } from './mathInterval.js';
import type { IntervalUnion } from './mathIntervalUnion.js';

export type FunctionPoint = readonly [number, number, number];
export type FunctionPointRanges = readonly [IntervalUnion, IntervalUnion, IntervalUnion];
function finitePoint(value: unknown): value is FunctionPoint {
  return Array.isArray(value) && value.length === 3 && [0,1,2].every(axis => {
    const item: unknown = value[axis]; return typeof item === 'number' && Number.isFinite(item);
  });
}
export function validFunctionWorldBounds(minimum: unknown, maximum: unknown): boolean {
  return finitePoint(minimum) && finitePoint(maximum) && minimum.every((value, axis) => value < maximum[axis]
    && Number.isFinite(maximum[axis]-value));
}
/** L1 encloses Euclidean displacement between an evaluated sample and the exact value enclosed by the interval VM. */
export function functionPointError(values: FunctionPointRanges, point: FunctionPoint): number {
  let error = 0;
  for (let axis = 0; axis < 3; axis++) {
    const value = values[axis];
    if (!value.continuous || value.ranges.length !== 1) return Infinity;
    const range = value.ranges[0];
    if (range.lower === point[axis] && range.upper === point[axis]) continue;
    const difference = intervalSubtract(range, { lower: point[axis], upper: point[axis] });
    if (difference.status !== 'range') return Infinity;
    error = nextFloat(error + Math.max(Math.abs(difference.interval.lower), Math.abs(difference.interval.upper)), 1);
  }
  return error;
}
/** A conservative interpolation error when a Hessian is unavailable: all exact vertex values lie in this box. */
export function functionRangeDiameter(values: FunctionPointRanges): number {
  let diameter = 0;
  for (const value of values) {
    if (!value.continuous || value.ranges.length !== 1) return Infinity;
    const range = value.ranges[0];
    if (range.lower === range.upper && Number.isFinite(range.lower)) continue;
    diameter = nextFloat(diameter + nextFloat(range.upper-range.lower, 1), 1);
  }
  return Number.isNaN(diameter) ? Infinity : diameter;
}
