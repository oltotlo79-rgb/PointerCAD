import { describe, expect, it } from 'vitest';
import type {
  ResolvedArc,
  ResolvedEllipse,
  ResolvedSegment,
  ResolvedSpline,
} from '@pointercad/model';

import {
  ARC_SEGMENTS_PER_TURN,
  sampleArc,
  sampleCurve,
  sampleEllipse,
  toLineSegmentPositions,
} from './sampleCurve.js';

const SEGMENT: ResolvedSegment = {
  kind: 'segment', featureId: 'l1', from: [0, 0, 0], to: [10, 0, 0],
};

const QUARTER_ARC: ResolvedArc = {
  kind: 'arc', featureId: 'a1', center: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0],
  radius: 10, startAngle: 0, endAngle: Math.PI / 2,
};

/** 長軸 20・短軸 10 の楕円の、パラメータ角 0 から π/2 まで。 */
const QUARTER_ELLIPSE: ResolvedEllipse = {
  kind: 'ellipse', featureId: 'e1', center: [0, 0, 0], normal: [0, 0, 1], majorAxis: [1, 0, 0],
  majorRadius: 20, minorRadius: 10, startAngle: 0, endAngle: Math.PI / 2,
};

/** 通過点方式の 4 点のスプライン。 */
const SPLINE: ResolvedSpline = {
  kind: 'spline', featureId: 'sp1', mode: 'interpolate', closed: false,
  points: [[0, 0, 0], [10, 5, 0], [20, 0, 0], [30, 5, 0]],
};

describe('曲線の折れ線化', () => {
  it('線分は 2 点', () => {
    expect(sampleCurve(SEGMENT)).toEqual([[0, 0, 0], [10, 0, 0]]);
  });

  it('90 度の円弧は 17 点(64 × 1/4 = 16 区間 + 1)', () => {
    const points = sampleCurve(QUARTER_ARC);
    expect(ARC_SEGMENTS_PER_TURN).toBe(64);
    // 区間数 = ceil((π/2) / 2π × 64) = ceil(16) = 16。点は区間数 + 1 = 17。
    expect(points).toHaveLength(17);
    // 半径 10 の円弧なので、どの点も中心(原点)から 10 の距離にある。
    for (const point of points) {
      expect(Math.hypot(point[0], point[1])).toBeCloseTo(10, 9);
      expect(point[2]).toBe(0);
    }
    // 端は開始角 0(= (10, 0))と終了角 90 度(= (0, 10))。
    expect(points[0][0]).toBeCloseTo(10, 9);
    expect(points[16][1]).toBeCloseTo(10, 9);
    // 中央の点は 45 度。10 × cos45° = 10 / √2 = 7.0710678118654755。
    expect(points[8][0]).toBeCloseTo(7.0710678118654755, 9);
    expect(points[8][1]).toBeCloseTo(7.0710678118654755, 9);
  });

  it('掃く角度で区間数が決まり、角度 0 でも 1 区間は作る', () => {
    // 全周: ceil(2π / 2π × 64) = 64 区間 → 65 点。
    expect(sampleArc({ ...QUARTER_ARC, endAngle: 2 * Math.PI })).toHaveLength(65);
    // 60 度: ceil(64 / 6) = ceil(10.666…) = 11 区間 → 12 点。
    expect(sampleArc({ ...QUARTER_ARC, endAngle: Math.PI / 3 })).toHaveLength(12);
    // 逆回り(-90 度)も掃く角度の絶対値で数える → 16 区間 → 17 点。
    expect(sampleArc({ ...QUARTER_ARC, endAngle: -Math.PI / 2 })).toHaveLength(17);
    // 退化(角度差 0)でも 1 区間 → 2 点。空の折れ線にしない。
    expect(sampleArc({ ...QUARTER_ARC, endAngle: 0 })).toHaveLength(2);
  });

  it('楕円弧は円弧と同じ数え方で刻み、点は楕円の上に乗る(FR-318)', () => {
    const points = sampleCurve(QUARTER_ELLIPSE);
    // 掃くパラメータ角は π/2 なので、円弧と同じく 16 区間 → 17 点。
    expect(points).toHaveLength(17);
    for (const point of points) {
      // (x/20)² + (y/10)² = 1 の上に乗っている。
      expect((point[0] / 20) ** 2 + (point[1] / 10) ** 2).toBeCloseTo(1, 9);
      expect(point[2]).toBe(0);
    }
    // 端はパラメータ角 0(=(20,0))と π/2(=(0,10))。
    expect(points[0][0]).toBeCloseTo(20, 9);
    expect(points[16][1]).toBeCloseTo(10, 9);
    // 全周の楕円は 64 区間 → 65 点。
    expect(sampleEllipse({ ...QUARTER_ELLIPSE, endAngle: 2 * Math.PI })).toHaveLength(65);
  });

  it('スプラインは model が解いた曲線の上を拾い、両端が最初と最後の点になる(FR-317)', () => {
    const points = sampleCurve(SPLINE);
    // 3 スパン × 既定の 16 分割 + 1。
    expect(points).toHaveLength(49);
    expect(points[0]).toEqual([0, 0, 0]);
    expect(points[48][0]).toBeCloseTo(30, 9);
    expect(points[48][1]).toBeCloseTo(5, 9);
  });

  it('線分ごとに 6 個の並びへ直せる', () => {
    expect(toLineSegmentPositions([[0, 0, 0], [1, 0, 0], [1, 1, 0]])).toEqual([
      0, 0, 0, 1, 0, 0,
      1, 0, 0, 1, 1, 0,
    ]);
    // 点が 1 個以下なら線分は作れない。
    expect(toLineSegmentPositions([[0, 0, 0]])).toEqual([]);
    expect(toLineSegmentPositions([])).toEqual([]);
  });
});
