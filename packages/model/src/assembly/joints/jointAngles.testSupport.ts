import { expect } from 'vitest';
import type { Quaternion } from '../placementMath.js';

/** Degrees of a pure z rotation; the transverse components must remain zero. */
export function zDegrees(rotation: Quaternion | undefined): number {
  const [x, y, z, w] = rotation ?? [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  expect(Math.abs(x) + Math.abs(y)).toBeLessThan(1e-9);
  return 2 * Math.atan2(z, w) * 180 / Math.PI;
}
