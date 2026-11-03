import type { Point2 } from './types.js';

/** Two-dimensional dot product, evaluated in coordinate order. */
export function dotPoint2(a: Point2, b: Point2): number {
  return a[0] * b[0] + a[1] * b[1];
}
