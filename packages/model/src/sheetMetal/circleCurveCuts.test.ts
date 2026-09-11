import { describe, expect, it } from 'vitest';
import { curvePointAt } from '../sketch/intersectionMath.js';
import type { ResolvedCurve } from '../sketch/types.js';
import { bernsteinRoots } from './bernsteinRoots.js';
import { sheetCurveCircleCuts } from './circleCurveCuts.js';

function coefficients(roots: readonly number[]): readonly number[] {
  let power = [1];
  for (const root of roots) {
    const next = Array.from({ length: power.length + 1 }, () => 0);
    for (const [i, value] of power.entries()) { next[i] -= root * value; next[i + 1] += value; }
    power = next;
  }
  const choose = (n: number, k: number) => { let value = 1; for (let i = 0; i < k; i++) value *= (n - i) / (i + 1); return value; };
  return power.map((_, i) => power.slice(0, i + 1).reduce((sum, value, k) => sum + value * choose(i, k) / choose(roots.length, k), 0));
}
const segment: ResolvedCurve = { kind: 'segment', featureId: 'line', from: [-5, 0, 0], to: [5, 0, 0] };
function cuts(curve: ResolvedCurve, radius: number) {
  const result = sheetCurveCircleCuts(curve, [0, 0, 0], radius, [0, 0, 1]); if (!result.ok) throw new Error(result.message);
  for (const at of result.value) expect(Math.hypot(...curvePointAt(curve, at))).toBeCloseTo(radius, 7);
  return result.value;
}

describe('長穴先端の円と曲線の交点', () => {
  it('6個の交差と3個の接点を、それぞれの独立した多項式から取り出す', () => {
    for (const expected of [[0, 0.1, 0.3, 0.6, 0.8, 1], [0.2, 0.2, 0.5, 0.5, 0.8, 0.8]]) {
      const roots = bernsteinRoots(coefficients(expected)), unique = [...new Set(expected)];
      expect(roots).toHaveLength(unique.length); unique.forEach((value, i) => expect(roots?.[i]).toBeCloseTo(value, 8));
    }
    expect(bernsteinRoots([0, 0, 0])).toBeNull(); expect(bernsteinRoots([1, 1, 1])).toEqual([]);
  });
  it('線分の交差・接線・端点・非交差を区別する', () => {
    const actual = cuts(segment, 3); expect(actual).toHaveLength(2);
    expect(actual[0]).toBeCloseTo(0.2, 10); expect(actual[1]).toBeCloseTo(0.8, 10);
    const tangent: ResolvedCurve = { ...segment, from: [-5, 3, 0], to: [5, 3, 0] };
    expect(cuts(tangent, 3)).toEqual([0.5]);
    expect(cuts(segment, 5)).toEqual([0, 1]);
    expect(cuts(tangent, 2)).toEqual([]);
  });
  it.each([1, -1])('向き%sの全楕円と円の4交点を解析角度で検算する', (direction) => {
    const ellipse: ResolvedCurve = { kind: 'ellipse', featureId: 'ellipse', center: [0, 0, 0], normal: [0, 0, 1], majorAxis: [1, 0, 0],
      majorRadius: 5, minorRadius: 3, startAngle: 0, endAngle: direction * 2 * Math.PI };
    const angle = Math.acos(Math.sqrt(7) / 4), expected = [angle, Math.PI - angle, Math.PI + angle, 2 * Math.PI - angle].map((value) => value / (2 * Math.PI));
    const actual = cuts(ellipse, 4); expect(actual).toHaveLength(4); expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 10));
  });
  it('三次スプラインの6交点をChebyshev多項式の解析解と照合する', () => {
    const spline: ResolvedCurve = { kind: 'spline', featureId: 'spline', mode: 'control', closed: false,
      points: [[-1, 0, 0], [5, 0, 0], [-5, 0, 0], [1, 0, 0]] };
    const expected = [-0.5, 0.5].flatMap((value) => [0, 1, 2].map((k) => (1 + Math.cos((Math.acos(value) + 2 * k * Math.PI) / 3)) / 2)).sort((a, b) => a - b);
    const actual = cuts(spline, 0.5); expect(actual).toHaveLength(6); expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 9));
  });
  it('一致する円と平面外の輪郭を有限個の交点として通さない', () => {
    const circle: ResolvedCurve = { kind: 'arc', featureId: 'arc', center: [0, 0, 0], radius: 3, normal: [0, 0, 1], xAxis: [1, 0, 0], startAngle: 0, endAngle: Math.PI };
    expect(sheetCurveCircleCuts(circle, [0, 0, 0], 3, [0, 0, 1]).ok).toBe(false);
    expect(sheetCurveCircleCuts({ ...segment, from: [-5, 0, 1] }, [0, 0, 0], 3, [0, 0, 1]).ok).toBe(false);
  });
});
