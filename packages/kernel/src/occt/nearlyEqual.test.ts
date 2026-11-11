import { describe, expect, it } from 'vitest';
import { nearlyEqual } from './nearlyEqual.js';

describe('face comparison tolerance', () => {
  it.each([
    [0, 1e-6, 0, true], [0, 1.000001e-6, 0, false],
    [0, 9e-5, 1000, true], [0, 11e-5, 1000, false],
    [-0, 0, 0, true], [NaN, 0, 1, false], [Infinity, Infinity, 1, false],
    [0, 1, Infinity, true],
  ] as const)('keeps the original bound for %s, %s and scale %s', (a, b, scale, expected) => {
    expect(nearlyEqual(a, b, scale)).toBe(expected);
  });
});
