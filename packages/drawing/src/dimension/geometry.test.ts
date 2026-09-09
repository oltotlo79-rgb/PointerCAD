import { describe, expect, it } from 'vitest';

import {
  createAngleDimensionGeometry,
  createArcLengthDimensionGeometry,
  createDiameterDimensionGeometry,
  createLinearDimensionGeometry,
  createRadiusDimensionGeometry,
} from './geometry.js';

describe('長さ寸法の幾何', () => {
  it('水平50mmの寸法線を10mm上へ置く', () => {
    const result = createLinearDimensionGeometry({ first: [0, 0], second: [50, 0], offset: 10 });
    expect(result?.dimensionLine).toEqual({ from: [0, 10], to: [50, 10] });
    expect(result?.value).toBe(50);
  });

  it('補助線は図形から1mm空け、寸法線を2mm越える', () => {
    const result = createLinearDimensionGeometry({ first: [0, 0], second: [50, 0], offset: 10 });
    expect(result?.extensionLines).toEqual([
      { from: [0, 1], to: [0, 12] },
      { from: [50, 1], to: [50, 12] },
    ]);
  });

  it('文字を寸法線中央の1mm上へ置く', () => {
    expect(createLinearDimensionGeometry({
      first: [0, 0], second: [50, 0], offset: 10,
    })?.textPosition).toEqual([25, 11]);
  });

  it('反対側の寸法線は負の側へ置く', () => {
    expect(createLinearDimensionGeometry({
      first: [0, 0], second: [50, 0], offset: -10,
    })?.dimensionLine).toEqual({ from: [0, -10], to: [50, -10] });
  });

  it('斜め30×40の紙上長さは50である', () => {
    expect(createLinearDimensionGeometry({
      first: [0, 0], second: [30, 40], offset: 10,
    })?.value).toBe(50);
  });

  it('共通法線座標hを使うと両端の法線座標が一致する', () => {
    const result = createLinearDimensionGeometry({
      first: [3, 2], second: [33, 42], commonNormalCoordinate: 12,
    });
    const from = result?.dimensionLine.from ?? [0, 0];
    const to = result?.dimensionLine.to ?? [0, 0];
    const normal = [-0.8, 0.6] as const;
    expect(from[0] * normal[0] + from[1] * normal[1]).toBeCloseTo(12, 12);
    expect(to[0] * normal[0] + to[1] * normal[1]).toBeCloseTo(12, 12);
  });

  it('同じ2点は寸法にできない', () => {
    expect(createLinearDimensionGeometry({ first: [1, 1], second: [1, 1], offset: 10 })).toBeNull();
  });
  it('明示した水平軸は30×40の対角を30として描く', () => {
    const result = createLinearDimensionGeometry({ first: [0, 0], second: [30, 40], direction: [1, 0], commonNormalCoordinate: 50 });
    expect(result?.value).toBe(30);
    expect(result?.dimensionLine).toEqual({ from: [0, 50], to: [30, 50] });
  });
  it('両端を逆にしても共通hを反転させず矢印の向きだけを変える', () => {
    const forward = createLinearDimensionGeometry({ first: [0, 0], second: [30, 40], direction: [1, 0], commonNormalCoordinate: 50 })!;
    const reverse = createLinearDimensionGeometry({ first: [30, 40], second: [0, 0], direction: [1, 0], commonNormalCoordinate: 50 })!;
    expect(reverse.dimensionLine).toEqual({ from: forward.dimensionLine.to, to: forward.dimensionLine.from });
    expect(reverse.arrows).toEqual([forward.arrows[1], forward.arrows[0]]);
    expect(reverse.value).toBe(30);
  });
  it('明示軸のゼロ距離と不正な方向を断る', () => {
    expect(createLinearDimensionGeometry({ first: [0, 0], second: [0, 40], direction: [1, 0] })).toBeNull();
    expect(createLinearDimensionGeometry({ first: [0, 0], second: [30, 40], direction: [0, 0] })).toBeNull();
    expect(createLinearDimensionGeometry({ first: [0, 0], second: [30, 40], direction: [NaN, 0] })).toBeNull();
  });
  it('両端の間へ寸法線を置くと各補助線はそれぞれ寸法線へ向かう', () => {
    expect(createLinearDimensionGeometry({ first: [0, 0], second: [30, 40], direction: [1, 0], commonNormalCoordinate: 10 })?.extensionLines)
      .toEqual([{ from: [0, 1], to: [0, 12] }, { from: [30, 39], to: [30, 8] }]);
  });
});

describe('角度・直径・半径・弧長寸法の幾何', () => {
  it('直角寸法は半径20の0〜π/2の円弧である', () => {
    const result = createAngleDimensionGeometry([0, 0], [1, 0], [0, 1], 20);
    expect(result?.dimensionArc).toEqual({ center: [0, 0], radius: 20, startAngle: 0, endAngle: Math.PI / 2 });
    expect(result?.valueDegrees).toBe(90);
  });

  it('直角寸法の文字は45度方向の半径21にある', () => {
    const result = createAngleDimensionGeometry([0, 0], [1, 0], [0, 1], 20);
    expect(result?.textPosition[0]).toBeCloseTo(14.849242404917499, 14);
    expect(result?.textPosition[1]).toBeCloseTo(14.849242404917499, 14);
  });

  it('平行な2方向から角度寸法を作らない', () => {
    expect(createAngleDimensionGeometry([0, 0], [1, 0], [-1, 0], 20)).toBeNull();
  });

  it('半径8の直径寸法は長さ16で円を貫く', () => {
    const result = createDiameterDimensionGeometry([2, 3], 8);
    expect(result?.value).toBe(16);
    expect(result?.dimensionLine).toEqual({ from: [-6, 3], to: [10, 3] });
    expect(result?.arrows).toHaveLength(2);
  });

  it('半径寸法は中心から円周へ1本と矢印1つを持つ', () => {
    const result = createRadiusDimensionGeometry([2, 3], 8, [0, 1]);
    expect(result?.dimensionLine).toEqual({ from: [2, 3], to: [2, 11] });
    expect(result?.arrows).toHaveLength(1);
  });

  it('半径10・90度の弧長は5πである', () => {
    const result = createArcLengthDimensionGeometry([0, 0], 10, 0, Math.PI / 2);
    expect(result?.value).toBeCloseTo(15.707963267948966, 14);
    expect(result?.symbol).toBe('⌒');
  });

  it('0以下の半径は寸法にしない', () => {
    expect(createDiameterDimensionGeometry([0, 0], 0)).toBeNull();
    expect(createRadiusDimensionGeometry([0, 0], -1)).toBeNull();
    expect(createArcLengthDimensionGeometry([0, 0], 0, 0, 1)).toBeNull();
  });
});
