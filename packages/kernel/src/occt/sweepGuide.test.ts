import { expectWithinBudget } from '@pointercad/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { faceTables } from './loftSurfaceTestSupport.js';
import { makeSweep, type SweepInput } from './makeSweep.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import { tessellate } from './tessellate.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
function segment(from: Vec3Tuple, to: Vec3Tuple): CurveSpec { return { kind: 'segment', from, to }; }
function circle(center: Vec3Tuple, radius: number, normal: Vec3Tuple = [0, 0, 1], endAngle = 2 * Math.PI): CurveSpec {
  return { kind: 'arc', center, radius, normal, xAxis: [1, 0, 0], startAngle: 0, endAngle };
}
function base(overrides: Partial<SweepInput> = {}): SweepInput {
  return { profile: [circle([0, 0, 0], 5)], path: [segment([0, 0, 0], [0, 0, 100])],
    guide: [segment([5, 0, 0], [2.5, 0, 100])], frenet: true, ...overrides };
}
function rectangle(): readonly CurveSpec[] {
  const points: readonly Vec3Tuple[] = [[4, 2, 0], [-4, 2, 0], [-4, -2, 0], [4, -2, 0]];
  return points.map((point, index) => segment(point, points[(index + 1) % points.length]));
}

describe('P11b 案内線の向き・倍率・対応区間', () => {
  it('円の縮小が円錐台の体積・終端の面積と一致し500ms以内', () => {
    const started = performance.now(), shape = makeSweep(oc, base()), elapsed = performance.now() - started;
    try {
      const expected = Math.PI * 100 * (25 + 12.5 + 6.25) / 3;
      expect(isValidShape(oc, shape.shape)).toBe(true);
      expect(Math.abs(measureVolume(oc, shape.shape) - expected) / expected).toBeLessThan(1e-4);
      const top = faceTables(oc, shape.shape).faces.find((face) => face.surfaceKind === 'plane' && Math.abs(face.centroid[2] - 100) < 1e-5);
      expect(top?.area).toBeCloseTo(Math.PI * 2.5 ** 2, 3);
      console.log(`P11b 案内線スイープ ${elapsed}ms/500、体積${measureVolume(oc, shape.shape)} / 手計算${expected}`);
      expectWithinBudget(elapsed, 500, 'P11b 案内線スイープ');
    } finally { shape.delete(); }
  });
  it.each(['rectangle', 'ellipse'])('非円断面%sも案内線で相似縮小する', (kind) => {
    const profile: readonly CurveSpec[] = kind === 'rectangle' ? rectangle() : [{ kind: 'ellipse', center: [0, 0, 0],
      normal: [0, 0, 1], majorAxis: [1, 0, 0], majorRadius: 5, minorRadius: 2 }];
    const guide = kind === 'rectangle' ? [segment([4, 2, 0], [2, 1, 100])] : base().guide;
    const shape = makeSweep(oc, base({ profile, guide }));
    try {
      const area = kind === 'rectangle' ? 32 : 10 * Math.PI;
      const expected = area * 100 * (1 + 0.5 + 0.25) / 3;
      expect(isValidShape(oc, shape.shape)).toBe(true);
      expect(Math.abs(measureVolume(oc, shape.shape) - expected) / expected).toBeLessThan(1e-4);
    } finally { shape.delete(); }
  });
  it('矩形の断面が90度回転し、途中の縮小も面積積分どおりになる', () => {
    const shape = makeSweep(oc, base({ profile: rectangle(), guide: [segment([4, 2, 0], [-2, 4, 100])] }));
    try {
      // |Q(t)-P(t)|² / |Q(0)-P(0)|² = (1-t)²+t²。積分は2/3。
      expect(Math.abs(measureVolume(oc, shape.shape) - 32 * 100 * 2 / 3) / (32 * 100 * 2 / 3)).toBeLessThan(1e-4);
      const mesh = tessellate(oc, shape.shape), xs: number[] = [], ys: number[] = [];
      for (let i = 0; i < mesh.positions.length; i += 3) if (Math.abs(mesh.positions[i + 2] - 100) < 1e-4) {
        xs.push(mesh.positions[i]); ys.push(mesh.positions[i + 1]);
      }
      expect(xs.length).toBeGreaterThan(0);
      expect(Math.max(...xs)).toBeCloseTo(2, 4); expect(Math.min(...xs)).toBeCloseTo(-2, 4);
      expect(Math.max(...ys)).toBeCloseTo(4, 4); expect(Math.min(...ys)).toBeCloseTo(-4, 4);
    } finally { shape.delete(); }
  });
  it.each([Math.PI / 2, Math.PI * 2])('円弧経路angle=%sでも同じ弧長比で案内し、全経路を生成する', (angle) => {
    const shape = makeSweep(oc, base({ profile: [circle([30, 0, 0], 5, [0, 1, 0])],
      path: [circle([0, 0, 0], 30, [0, 0, 1], angle)], guide: [circle([0, 0, 0], 35, [0, 0, 1], angle)] }));
    try {
      const expected = Math.PI * 25 * 30 * angle;
      expect(isValidShape(oc, shape.shape)).toBe(true);
      expect(Math.abs(measureVolume(oc, shape.shape) - expected) / expected).toBeLessThan(1e-4);
    } finally { shape.delete(); }
  });
  it.each([
    { name: '区間のずれ', curves: [segment([5, 0, 10], [2.5, 0, 110])], error: '対応区間' },
    { name: '逆方向', curves: [segment([2.5, 0, 100], [5, 0, 0])], error: '対応区間' },
    { name: '経路と交差', curves: [segment([5, 0, 0], [-5, 0, 100])], error: '重なる' },
    { name: '断面から離れた始点', curves: [segment([10, 0, 0], [5, 0, 100])], error: '断面の縁' },
  ])('$nameを別の理由で拒否し、続けて正常な形を作れる', ({ curves, error }) => {
    expect(() => makeSweep(oc, base({ guide: curves }))).toThrow(error);
    const shape = makeSweep(oc, base());
    try { expect(isValidShape(oc, shape.shape)).toBe(true); } finally { shape.delete(); }
  });
});
