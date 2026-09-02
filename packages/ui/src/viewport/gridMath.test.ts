import { describe, expect, it } from 'vitest';

import {
  axisLength,
  GRID_FADE_START_RATIO,
  gridExtent,
  gridFadeOpacity,
  gridSpacing,
  isMajorGridLine,
  MAJOR_GRID_INTERVAL,
} from './gridMath.js';

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

describe('方眼の主線と副線の区別(FR-104)', () => {
  it('原点から 5 本ごとが主線', () => {
    expect(MAJOR_GRID_INTERVAL).toBe(5);
    for (const index of [0, 5, 10, 15, 20, -5, -10, -20]) {
      expect(isMajorGridLine(index), `${index}`).toBe(true);
    }
  });

  it('その間の線は副線', () => {
    for (const index of [1, 2, 3, 4, 6, 9, 11, 19, -1, -4, -7]) {
      expect(isMajorGridLine(index), `${index}`).toBe(false);
    }
  });

  it('主線は副線より少ない', () => {
    let major = 0;
    for (let index = -20; index <= 20; index += 1) {
      if (isMajorGridLine(index)) {
        major += 1;
      }
    }
    expect(major).toBe(9);
  });
});

describe('遠くの方眼が薄くなる度合い(FR-104)', () => {
  const EXTENT = 200;

  it('原点まわりは薄くならない', () => {
    expect(gridFadeOpacity(0, EXTENT)).toBe(1);
    expect(gridFadeOpacity(EXTENT * GRID_FADE_START_RATIO, EXTENT)).toBeCloseTo(1, 12);
  });

  it('広がりの端では完全に消える', () => {
    expect(gridFadeOpacity(EXTENT, EXTENT)).toBeCloseTo(0, 12);
    expect(gridFadeOpacity(EXTENT * 1.5, EXTENT)).toBe(0);
  });

  it('薄くなり始めてから端までの中間ではちょうど半分', () => {
    const middle = EXTENT * (GRID_FADE_START_RATIO + (1 - GRID_FADE_START_RATIO) / 2);
    expect(gridFadeOpacity(middle, EXTENT)).toBeCloseTo(0.5, 12);
  });

  it('遠ざかるほど濃くはならず、常に 0 〜 1 に収まる', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let distance = 0; distance <= EXTENT * 2; distance += 1) {
      const opacity = gridFadeOpacity(distance, EXTENT);
      expect(opacity).toBeGreaterThanOrEqual(0);
      expect(opacity).toBeLessThanOrEqual(1);
      expect(opacity).toBeLessThanOrEqual(previous + 1e-12);
      previous = opacity;
    }
  });

  it('間隔が変わっても広がりに対する比が同じなら同じ薄さ', () => {
    expect(gridFadeOpacity(100, 200)).toBeCloseTo(gridFadeOpacity(1000, 2000), 12);
  });
});
