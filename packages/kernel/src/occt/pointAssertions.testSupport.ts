import { expect } from 'vitest';

import type { Vec3Tuple } from '../types.js';

/** Compare components in order using the caller's original decimal digits. */
export function expectPointClose(actual: Vec3Tuple, expected: Vec3Tuple, digits: number): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

/** Placement and transform fixtures retain their original nine-digit default. */
export function expectTuple(actual: Vec3Tuple, expected: Vec3Tuple, digits = 9): void {
  expectPointClose(actual, expected, digits);
}

/** 長さ 1 へ揃える(検査の中で法線を作るときに使う)。 */
export function unit(value: Vec3Tuple): Vec3Tuple {
  const length = Math.hypot(value[0], value[1], value[2]);
  return [value[0] / length, value[1] / length, value[2] / length];
}
