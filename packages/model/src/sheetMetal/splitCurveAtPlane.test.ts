import { describe, expect, it } from 'vitest';
import { curvePointAt } from '../sketch/intersectionMath.js';
import type { ResolvedCurve, ResolvedSpline } from '../sketch/types.js';
import { distanceVec3 } from '../sketch/vec3.js';
import { sheetBezierPlaneRoots } from './bezierSpans.js';
import { splitSheetCurveAtPlane } from './splitCurveAtPlane.js';

const plane = { origin: [0, 0, 0], normal: [0, 1, 0] } as const;
function checked(curve: ResolvedCurve) {
  const split = splitSheetCurveAtPlane(curve, plane); if (!split.ok) throw new Error(split.message);
  expect(split.value.length).toBeGreaterThan(0);
  expect(split.value[0].from).toBe(0); expect(split.value[split.value.length - 1].to).toBe(1);
  for (const [index, piece] of split.value.entries()) {
    if (index > 0) expect(piece.from).toBeCloseTo(split.value[index - 1].to, 12);
    for (let sample = 0; sample <= 20; sample++) {
      const ratio = sample / 20, actual = curvePointAt(piece.curve, ratio), original = curvePointAt(curve, piece.from + (piece.to - piece.from) * ratio);
      expect(distanceVec3(actual, original)).toBeLessThan(1e-8);
      if (piece.side !== 0) expect(actual[1] * piece.side).toBeGreaterThanOrEqual(-1e-7);
    }
  }
  return split.value;
}
describe('指定線曲げの境界で曲線を厳密な種類のまま分割する', () => {
  it('横切る線分は交点で分かれ、面上の線は境界として残る', () => {
    const pieces = checked({ kind: 'segment', featureId: 'line', from: [-10, -2, 0], to: [10, 6, 0] });
    expect(pieces.map((piece) => piece.side)).toEqual([-1, 1]); expect(pieces[0].to).toBe(0.25);
    expect(curvePointAt(pieces[0].curve, 1)).toEqual([-5, 0, 0]);
    expect(checked({ kind: 'segment', featureId: 'line', from: [-10, 0, 0], to: [10, 0, 0] })[0].side).toBe(0);
  });
  it.each([1, -1])('正逆の円弧と楕円の半径・軸・向きは分割後も保つ (%s)', (sign) => {
    const arc: ResolvedCurve = { kind: 'arc', featureId: 'round', center: [2, 1, 0], radius: 5, normal: [0, 0, 1], xAxis: [1, 0, 0], startAngle: 0, endAngle: sign * 2 * Math.PI };
    const pieces = checked(arc); expect(pieces).toHaveLength(3);
    expect(pieces.every((piece) => piece.curve.kind === 'arc' && piece.curve.radius === 5)).toBe(true);
    const ellipse: ResolvedCurve = { kind: 'ellipse', featureId: 'oval', center: [2, 1, 0], majorRadius: 7, minorRadius: 3, normal: [0, 0, 1],
      majorAxis: [Math.SQRT1_2, Math.SQRT1_2, 0], startAngle: 0, endAngle: sign * 2 * Math.PI };
    expect(checked(ellipse).every((piece) => piece.curve.kind === 'ellipse' && piece.curve.majorRadius === 7)).toBe(true);
  });
  it.each(['control', 'interpolate'] as const)('複数の節点区間と閉曲線をBezierへ正確に分割する (%s)', (mode) => {
    for (const closed of [false, true]) {
      const spline: ResolvedSpline = { kind: 'spline', featureId: 'spline', mode, closed,
        points: [[-20, -4, 0], [-10, 12, 0], [0, -8, 0], [10, 7, 0], [20, -5, 0], [30, 3, 0]] };
      const before = JSON.stringify(spline), pieces = checked(spline);
      expect(pieces.length).toBeGreaterThan(3); expect(pieces.every((piece) => piece.curve.kind === 'spline')).toBe(true);
      expect(JSON.stringify(spline)).toBe(before);
    }
  });
  it('3交点の3次式と接する2重根を拾い、同じ側の曲線に偽の交点を足さない', () => {
    const roots = sheetBezierPlaneRoots([-0.08, 0.14, -0.14, 0.08]);
    expect(roots).toHaveLength(3); for (const [i, expected] of [0.2, 0.5, 0.8].entries()) expect(roots[i]).toBeCloseTo(expected, 12);
    expect(sheetBezierPlaneRoots([1, -1 / 3, -1 / 3, 1])).toEqual([0.5]);
    expect(sheetBezierPlaneRoots([1, 2, 3, 4])).toEqual([]);
    const spline: ResolvedSpline = { kind: 'spline', featureId: 'three', mode: 'control', closed: false,
      points: [[0, -0.08, 0], [1, 0.14, 0], [2, -0.14, 0], [3, 0.08, 0]] };
    expect(checked(spline).map((piece) => piece.side)).toEqual([-1, 1, -1, 1]);
  });
  it('平面の不正・非有限座標・無効な半径を断る', () => {
    const line: ResolvedCurve = { kind: 'segment', featureId: 'line', from: [-1, -1, 0], to: [1, 1, 0] };
    expect(splitSheetCurveAtPlane(line, { ...plane, normal: [0, 2, 0] }).ok).toBe(false);
    expect(splitSheetCurveAtPlane({ ...line, to: [Infinity, 0, 0] }, plane).ok).toBe(false);
    expect(splitSheetCurveAtPlane({ kind: 'arc', featureId: 'bad', center: [0, 0, 0], xAxis: [1, 0, 0], normal: [0, 0, 1], radius: -1, startAngle: 0, endAngle: Math.PI }, plane).ok).toBe(false);
  });
});
