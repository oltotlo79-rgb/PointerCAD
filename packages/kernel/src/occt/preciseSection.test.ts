import { beforeAll, describe, expect, it } from 'vitest';
import type { EllipseCurveSpec } from '../types.js';
import { curveSampleCoordinates } from './curveSampleCoordinates.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeEllipseEdge } from './makeEllipseEdge.js';
import { makeSection } from './makeSection.js';
import { makeSheetMetalBase } from './makeSheetMetalBase.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); });
const cx = 10_000_000.125, cy = 10_000_000.25, a = 10.5, b = 6.25;
const ellipse: EllipseCurveSpec = { kind: 'ellipse', center: [cx, cy, 0], normal: [0, 0, 1],
  majorAxis: [1, 0, 0], majorRadius: a, minorRadius: b };
const plane = { origin: [0, 0, 1], axisU: [1, 0, 0], normal: [0, 0, 1] } as const;

describe('製作用断面の精度と資源寿命（P10 DXF）', () => {
  it('1千万mm離れた楕円をdoubleで取り出し、100点を越えても0.001mmの弦誤差を保つ', () => {
    const handle = makeSheetMetalBase(oc, { outer: [ellipse], holes: [], thickness: 2, reversed: false });
    try {
      const result = makeSection(oc, { target: handle.shape, plane, curveToleranceMm: 0.001 });
      expect(result.curves).toHaveLength(1);
      const curve = result.curves[0];
      if (curve.kind !== 'polyline') throw new Error('楕円の精密断面がありません');
      expect(curve.closed).toBe(true);
      expect(curve.points.length).toBeGreaterThan(100);
      for (const [index, point] of curve.points.entries()) {
        const x = point[0] - cx, y = point[1] - cy;
        const radial = Math.sqrt((x / a) ** 2 + (y / b) ** 2);
        // OCCTの面との交差近似も含め、無次元の残差ではなくmmで誤差を測る。
        expect(Math.hypot(x - x / radial, y - y / radial)).toBeLessThanOrEqual(0.001);
        const next = curve.points[(index + 1) % curve.points.length];
        // 楕円の径数の中間点と弦の距離を解析式から測る（実装の標本器は使わない）。
        const t0 = Math.atan2(y / b, x / a);
        const rawDelta = Math.atan2((next[1] - cy) / b, (next[0] - cx) / a) - t0;
        const delta = Math.atan2(Math.sin(rawDelta), Math.cos(rawDelta));
        const mx = a * Math.cos(t0 + delta / 2), my = b * Math.sin(t0 + delta / 2);
        const dx = next[0] - point[0], dy = next[1] - point[1];
        const distance = Math.abs(dx * (my - y) - dy * (mx - x)) / Math.hypot(dx, dy);
        expect(distance).toBeLessThanOrEqual(0.001);
      }
    } finally { handle.delete(); }
  });
  it('点数超過や不正精度を断った後も同じ稜線を再利用できる', () => {
    const handle = makeEllipseEdge(oc, ellipse);
    try {
      expect(() => curveSampleCoordinates(oc, handle.edge, { linearDeflection: 0.001 }, 2)).toThrow('上限');
      for (const linearDeflection of [0, -1, NaN, Infinity]) {
        expect(() => curveSampleCoordinates(oc, handle.edge, { linearDeflection })).toThrow('正の有限値');
      }
      const coordinates = curveSampleCoordinates(oc, handle.edge, { linearDeflection: 0.001 }, 100_000);
      expect(coordinates).toBeInstanceOf(Float64Array);
      expect(coordinates.length).toBeGreaterThan(300);
      expect(coordinates[0]).toBeCloseTo(cx + a, 8);
      for (let i = 0; i < coordinates.length; i += 3) {
        const residual = ((coordinates[i] - cx) / a) ** 2 + ((coordinates[i + 1] - cy) / b) ** 2 - 1;
        expect(Math.abs(residual)).toBeLessThan(1e-7);
      }
    } finally { handle.delete(); }
  });
  it('不正な断面精度は処理前に拒否し、直線と円は解析曲線のまま出す', () => {
    const circle = { kind: 'arc', center: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 10,
      startAngle: 0, endAngle: 2 * Math.PI } as const;
    const handle = makeSheetMetalBase(oc, { outer: [circle], holes: [], thickness: 2, reversed: false });
    try {
      for (const curveToleranceMm of [0, -1, NaN, Infinity, 1e-8]) {
        expect(() => makeSection(oc, { target: handle.shape, plane, curveToleranceMm })).toThrow('精度');
      }
      const result = makeSection(oc, { target: handle.shape, plane, curveToleranceMm: 0.001 });
      expect(result.curves).toHaveLength(1);
      expect(result.curves[0]).toMatchObject({ kind: 'arc', radius: 10 });
    } finally { handle.delete(); }
  });
});
