import { describe, expect, it } from 'vitest';
import { trigonometricInterval } from './trigonometricIntervals.js';
import { exactDegreeTrig } from './exactDegreeTrig.js';

describe('三角関数の区間を丸め方向付きTaylor展開で包む', () => {
  it.each([
    [-3.2, -3.1], [-1.7, -1.5], [-0.01, 0.01], [1e-30, 2e-30], [1.5, 1.7], [3.1, 3.2],
    [100, 100.01], [-1000, -999.999], [1e12, 1e12 + 0.01], [-1e100, 1e100],
  ])('[%s,%s]のsin/cosが両端と内部の独立評価値を包含する', (lower, upper) => {
    for (const cosine of [false, true]) for (const degree of [false, true]) {
      const result = trigonometricInterval({ lower, upper }, cosine, degree);
      if (result.status !== 'range') throw new Error(JSON.stringify(result));
      const operation = cosine ? Math.cos : Math.sin;
      for (let index = 0; index <= 32; index++) {
        const input = lower + (upper-lower)*index/32;
        const value = operation(input*(degree ? Math.PI/180 : 1));
        expect(value).toBeGreaterThanOrEqual(result.interval.lower);
        expect(value).toBeLessThanOrEqual(result.interval.upper);
      }
    }
  });
  it('微小なsinの値域を固定の絶対誤差でゼロへ広げない', () => {
    const result = trigonometricInterval({ lower: 1e-30, upper: 1e-30 }, false, false);
    if (result.status !== 'range') throw new Error(JSON.stringify(result));
    expect(result.interval.lower).toBeGreaterThan(0.999e-30);
    expect(result.interval.upper).toBeLessThan(1.001e-30);
  });
  it('度数の厳密な四分周だけを整数演算で確定し、隣接する数やラジアンへ流用しない', () => {
    expect(exactDegreeTrig(90, true)).toEqual({ sin: 1, cos: 0 });
    expect(exactDegreeTrig(-450, true)).toEqual({ sin: -1, cos: 0 });
    expect(exactDegreeTrig(360*1e10, true)).toEqual({ sin: 0, cos: 1 });
    for (const value of [90.00000000000001, 89.99999999999999, 1e30, Infinity, NaN]) {
      expect(exactDegreeTrig(value, true)).toBeNull();
    }
    expect(exactDegreeTrig(90, false)).toBeNull();
    expect(trigonometricInterval({ lower: 90, upper: 90 }, true, true))
      .toEqual({ status: 'range', interval: { lower: 0, upper: 0 } });
  });
  it('再利用と古い値の追出しを挟んでも、区間端・sin/cos・度/ラジアンを混同しない', () => {
    const inputs = [
      { lower: 0.3, upper: 0.3 }, { lower: 0.3, upper: 0.30000000000000004 },
      { lower: 0.30000000000000004, upper: 0.30000000000000004 },
      { lower: -0.3, upper: -0.3 }, { lower: -0.3, upper: 0.3 },
      { lower: 1e-30, upper: 2e-30 }, { lower: 90, upper: 90 },
    ];
    const samples = inputs.flatMap(input => [false, true].flatMap(cosine => [false, true].map(degree => {
      const expected = trigonometricInterval(input, cosine, degree);
      if (expected.status !== 'range') throw new Error(JSON.stringify(expected));
      const middle = input.lower + (input.upper-input.lower)/2;
      const point = (cosine ? Math.cos : Math.sin)(middle*(degree ? Math.PI/180 : 1));
      // Exact degree quarter turns are tested separately, avoiding Math.cos(pi/2)'s nonzero result.
      if (!degree || middle !== 90) {
        expect(point).toBeGreaterThanOrEqual(expected.interval.lower);
        expect(point).toBeLessThanOrEqual(expected.interval.upper);
      }
      return { input, cosine, degree, expected };
    })));
    for (const sample of samples) expect(trigonometricInterval(sample.input, sample.cosine, sample.degree)).toEqual(sample.expected);
    // More than the fixed capacity, followed by the same inputs in reverse order.
    for (let index = 0; index < 4096; index++) {
      const point = 0.123 + index/4096;
      trigonometricInterval({ lower: point, upper: point }, index%2 === 0, index%3 === 0);
    }
    for (const sample of samples.reverse()) expect(trigonometricInterval(sample.input, sample.cosine, sample.degree)).toEqual(sample.expected);
  });
});
