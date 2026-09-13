import { describe, expect, it } from 'vitest';
import { logarithmicPositiveRange } from './logarithmicIntervals.js';

describe('対数の級数・剰余・単調性による区間評価', () => {
  it.each([Number.MIN_VALUE, 2**-1022, 1e-300, 0.1, 0.5, 0.9999999999999999, 1,
    1.0000000000000002, 1.5, 1.9999999999999998, 2, 10, 1e100, Number.MAX_VALUE])(
    '%sのln/log2/log10が独立評価値を包み、有限な点では不必要な無限区間を返さない', value => {
      for (const base of ['e', 'two', 'ten'] as const) {
        const range = logarithmicPositiveRange({ lower: value, upper: value }, base);
        if (range === null) throw new Error('Expected finite positive logarithm');
        const expected = base === 'e' ? Math.log(value) : base === 'two' ? Math.log2(value) : Math.log10(value);
        expect(expected).toBeGreaterThanOrEqual(range.lower); expect(expected).toBeLessThanOrEqual(range.upper);
        expect(range.upper-range.lower).toBeLessThan(1e-10);
      }
    });
  it('0へ近付く正の領域を最小doubleへ切り詰めず、負の無限大まで保持する', () => {
    const range = logarithmicPositiveRange({ lower: -2, upper: 0.001 }, 'e');
    expect(range?.lower).toBe(-Infinity); expect(range?.upper).toBeLessThan(-6.9);
    expect(logarithmicPositiveRange({ lower: 0, upper: Infinity }, 'e')).toEqual({ lower: -Infinity, upper: Infinity });
    expect(logarithmicPositiveRange({ lower: -2, upper: 0 }, 'e')).toBeNull();
    expect(logarithmicPositiveRange({ lower: 2, upper: 1 }, 'e')).toBeNull();
    expect(logarithmicPositiveRange({ lower: NaN, upper: 1 }, 'e')).toBeNull();
  });
});
