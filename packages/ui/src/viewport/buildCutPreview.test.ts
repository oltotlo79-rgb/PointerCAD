/**
 * 切断面の予告の頂点(`buildCutPreview.ts`)の検査
 * (計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク27e の検証表、§0.a-0.61)。
 *
 * 期待値の導出:
 * - 40 × 30 × 10 の板の境界箱の対角長 = √(40² + 30² + 10²) = √2600 = 50.99019513592785
 * - 20³ の立方体の対角長 = √(20² × 3) = √1200 = 34.64101615137755
 * 予告の四角は**その対角長を対角に持つ正方形**なので、向かい合う角どうしの距離が
 * ちょうど対角長になる。
 */

import type { ResolvedPlane } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { buildCutPreviewPositions } from './buildCutPreview.js';

/** z = 5 の高さにある、法線 +Z の平面。 */
const XY_AT_Z5: ResolvedPlane = {
  origin: [0, 0, 5],
  axisU: [1, 0, 0],
  axisV: [0, 1, 0],
  normal: [0, 0, 1],
};

const PLATE_DIAGONAL = 50.99019513592785;
const CUBE_DIAGONAL = 34.64101615137755;

/** 位置の並びを 3 個ずつの点へ切り分ける。 */
function pointsOf(positions: Float32Array): readonly (readonly [number, number, number])[] {
  const points: [number, number, number][] = [];
  for (let index = 0; index + 2 < positions.length; index += 3) {
    points.push([positions[index] ?? 0, positions[index + 1] ?? 0, positions[index + 2] ?? 0]);
  }
  return points;
}

function distance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('切断面の予告の四角(タスク27e、§0.a-0.61)', () => {
  it('三角形 2 枚(18 個の実数)で四角を作る', () => {
    const { facePositions } = buildCutPreviewPositions(XY_AT_Z5, PLATE_DIAGONAL, 'positive');
    expect(facePositions).toBeInstanceOf(Float32Array);
    expect(facePositions).toHaveLength(18);
  });

  it('4 つの角がすべて平面の上に乗る(40 × 30 × 10、z = 5)', () => {
    const { facePositions } = buildCutPreviewPositions(XY_AT_Z5, PLATE_DIAGONAL, 'positive');
    for (const point of pointsOf(facePositions)) {
      expect(point[2]).toBeCloseTo(5, 5);
    }
  });

  it('対角長が板の境界箱の対角長と同じ正方形になる(√2600)', () => {
    const { facePositions } = buildCutPreviewPositions(XY_AT_Z5, PLATE_DIAGONAL, 'positive');
    const points = pointsOf(facePositions);
    // 1 枚目の三角形は 角00 → 角10 → 角11。00 と 11 が向かい合う角。
    const c00 = points[0];
    const c10 = points[1];
    const c11 = points[2];
    expect(c00).toBeDefined();
    expect(c10).toBeDefined();
    expect(c11).toBeDefined();
    if (c00 === undefined || c10 === undefined || c11 === undefined) {
      return;
    }
    expect(distance(c00, c11)).toBeCloseTo(PLATE_DIAGONAL, 5);
    // 1 辺は対角長 / √2。4 辺とも同じ長さ(正方形)。
    expect(distance(c00, c10)).toBeCloseTo(PLATE_DIAGONAL / Math.SQRT2, 5);
    expect(distance(c10, c11)).toBeCloseTo(PLATE_DIAGONAL / Math.SQRT2, 5);
  });

  it('20³ の立方体では対角長 √1200 になる', () => {
    const { facePositions } = buildCutPreviewPositions(XY_AT_Z5, CUBE_DIAGONAL, 'positive');
    const points = pointsOf(facePositions);
    const c00 = points[0];
    const c11 = points[2];
    if (c00 === undefined || c11 === undefined) {
      return;
    }
    expect(distance(c00, c11)).toBeCloseTo(CUBE_DIAGONAL, 5);
  });

  it('四角の中心は平面の原点(境界箱の中心を渡せばそこが中心になる)', () => {
    const { facePositions } = buildCutPreviewPositions(
      { ...XY_AT_Z5, origin: [20, 15, 5] },
      PLATE_DIAGONAL,
      'positive',
    );
    const points = pointsOf(facePositions);
    const c00 = points[0];
    const c11 = points[2];
    if (c00 === undefined || c11 === undefined) {
      return;
    }
    expect((c00[0] + c11[0]) / 2).toBeCloseTo(20, 5);
    expect((c00[1] + c11[1]) / 2).toBeCloseTo(15, 5);
  });

  it('大きさが 0 以下・数でないときは頂点を 1 つも作らない', () => {
    for (const diagonal of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const positions = buildCutPreviewPositions(XY_AT_Z5, diagonal, 'positive');
      expect(positions.facePositions, String(diagonal)).toHaveLength(0);
      expect(positions.arrowPositions, String(diagonal)).toHaveLength(0);
    }
  });
});

describe('残る側を示す矢印(§0.a-0.57)', () => {
  it('線分 3 本(軸 1 本と羽 2 本)で描く', () => {
    const { arrowPositions } = buildCutPreviewPositions(XY_AT_Z5, PLATE_DIAGONAL, 'positive');
    expect(arrowPositions).toHaveLength(18);
  });

  it('法線の側を残すときは法線の向きへ伸びる', () => {
    const { arrowPositions } = buildCutPreviewPositions(XY_AT_Z5, PLATE_DIAGONAL, 'positive');
    const points = pointsOf(arrowPositions);
    const start = points[0];
    const tip = points[1];
    if (start === undefined || tip === undefined) {
      return;
    }
    expect(start).toEqual([0, 0, 5]);
    expect(tip[2]).toBeGreaterThan(start[2]);
  });

  it('反対側を残すときは法線の逆へ伸びる', () => {
    const { arrowPositions } = buildCutPreviewPositions(XY_AT_Z5, PLATE_DIAGONAL, 'negative');
    const points = pointsOf(arrowPositions);
    const start = points[0];
    const tip = points[1];
    if (start === undefined || tip === undefined) {
      return;
    }
    expect(tip[2]).toBeLessThan(start[2]);
  });

  it('矢印の長さは残す側で変わらない(向きだけが逆になる)', () => {
    const points = pointsOf(
      buildCutPreviewPositions(XY_AT_Z5, PLATE_DIAGONAL, 'positive').arrowPositions,
    );
    const flipped = pointsOf(
      buildCutPreviewPositions(XY_AT_Z5, PLATE_DIAGONAL, 'negative').arrowPositions,
    );
    const a = points[0];
    const b = points[1];
    const c = flipped[0];
    const d = flipped[1];
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
      return;
    }
    expect(distance(a, b)).toBeCloseTo(distance(c, d), 10);
  });

  it('斜めの平面でも四角は必ず平面の上に乗る', () => {
    const tilted: ResolvedPlane = {
      origin: [1, 2, 3],
      axisU: [0, 1, 0],
      axisV: [0, 0, 1],
      normal: [1, 0, 0],
    };
    const { facePositions } = buildCutPreviewPositions(tilted, CUBE_DIAGONAL, 'positive');
    for (const point of pointsOf(facePositions)) {
      // 法線が +X なので、平面上の点は x が原点と同じ。
      expect(point[0]).toBeCloseTo(1, 5);
    }
  });
});
