import { describe, expect, it } from 'vitest';

import { axisLength, gridExtent, gridSpacing } from './gridMath.js';

describe('方眼の間隔の自動調整(FR-104)', () => {
  it.each([
    [100, 10],
    [200, 20],
    [250, 50],
    [500, 50],
    [1000, 100],
    [30, 5],
    [10, 1],
    [5, 0.5],
    [0.5, 0.05],
  ])('カメラ距離 %d mm では間隔 %d mm', (distance, expected) => {
    expect(gridSpacing(distance)).toBeCloseTo(expected, 9);
  });

  it('距離が大きくなると間隔は決して小さくならない', () => {
    let previous = 0;
    for (let distance = 0.1; distance < 10_000; distance *= 1.3) {
      const spacing = gridSpacing(distance);
      expect(spacing).toBeGreaterThanOrEqual(previous);
      previous = spacing;
    }
  });

  it('間隔は必ず 1, 2, 5 のいずれかを 10 のべき乗倍した値になる', () => {
    for (let distance = 0.1; distance < 10_000; distance *= 1.7) {
      const spacing = gridSpacing(distance);
      const normalized = spacing / Math.pow(10, Math.floor(Math.log10(spacing)));
      expect([1, 2, 5].some((factor) => Math.abs(normalized - factor) < 1e-9)).toBe(true);
    }
  });

  it('方眼と軸の広がりは間隔の 20 倍', () => {
    expect(gridExtent(10)).toBe(200);
    expect(axisLength(10)).toBe(200);
  });
});
