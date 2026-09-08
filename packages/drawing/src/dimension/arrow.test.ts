import { describe, expect, it } from 'vitest';

import { ARROW_WIDTH_MM } from '../style/jisStyle.js';
import { blackDot, createArrowTriangle, shouldUseOutwardArrows } from './arrow.js';

describe('寸法の矢印', () => {
  const arrow = createArrowTriangle([10, 5], [1, 0]);

  it('先端と根元2点の3点である', () => {
    expect(arrow.points).toHaveLength(3);
    expect(arrow.points[0]).toEqual([10, 5]);
  });

  it('X正方向の矢は根元が3.5mm後ろにある', () => {
    expect(arrow.points[1]?.[0]).toBeCloseTo(6.5, 14);
    expect(arrow.points[2]?.[0]).toBeCloseTo(6.5, 14);
  });

  it('矢の全幅が設計値に一致する', () => {
    expect(Math.abs((arrow.points[1]?.[1] ?? 0) - (arrow.points[2]?.[1] ?? 0))).toBeCloseTo(
      0.9215674831117708,
      14,
    );
    expect(ARROW_WIDTH_MM).toBeCloseTo(0.9215674831117708, 14);
  });

  it('三角形の面積が設計値に一致する', () => {
    expect(3.5 * ARROW_WIDTH_MM / 2).toBeCloseTo(1.612743095445599, 14);
  });

  it('20mmなら内向き、5mmなら外向きである', () => {
    expect(shouldUseOutwardArrows(20)).toBe(false);
    expect(shouldUseOutwardArrows(5)).toBe(true);
  });

  it('文字幅も外向き判定に含める', () => {
    expect(shouldUseOutwardArrows(20, 12, 2)).toBe(true);
  });

  it('黒丸の直径は矢印長さの3分の1である', () => {
    expect(blackDot([1, 2])).toEqual({
      center: [1, 2], diameter: 3.5 / 3, radius: 3.5 / 6,
    });
  });
});
