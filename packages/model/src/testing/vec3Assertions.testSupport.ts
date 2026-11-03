import { expect } from 'vitest';
import type { Vec3 } from '../sketch/vec3.js';

export function expectVec3CloseTo(actual: Vec3, expected: Vec3, digits = 9): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}
