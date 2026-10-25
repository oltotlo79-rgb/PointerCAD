import { beforeAll, describe, expect, it } from 'vitest';

import type { Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { borrowHandle } from './borrowHandle.js';
import { continuousCurvePieces } from './continuousCurvePieces.js';
import { functionCurvePolylines } from './functionCurvePolylines.js';
import type { FunctionCurveSplineCurve, FunctionCurveSplineSpec } from './functionCurveSpline.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { FunctionCurveGeometrySpec } from './makeFunctionCurve.js';
import { bsplineDataForSpline, makeSplineEdge } from './makeSplineEdge.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;
let oc: Occt;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

/**
 * Independent test construction: cubic Hermite of the unit circle with its analytic tangents at deliberately
 * nonuniform parameters, written in the documented pole layout (start, two inner poles per span, end).
 */
function circleSpline(parameters: readonly number[]): { spec: FunctionCurveSplineSpec; samples: Vec3Tuple[] } {
  const point = (t: number): Vec3Tuple => [Math.cos(t), Math.sin(t), 0];
  const tangent = (t: number): Vec3Tuple => [-Math.sin(t), Math.cos(t), 0];
  const poles: Vec3Tuple[] = [point(parameters[0])];
  for (let span = 0; span < parameters.length - 1; span++) {
    const a = parameters[span], b = parameters[span + 1], h = b - a;
    const pa = point(a), pb = point(b), ma = tangent(a), mb = tangent(b);
    poles.push([pa[0] + h * ma[0] / 3, pa[1] + h * ma[1] / 3, 0], [pb[0] - h * mb[0] / 3, pb[1] - h * mb[1] / 3, 0]);
  }
  poles.push(point(parameters[parameters.length - 1]));
  return { spec: { knots: [...parameters], poles }, samples: parameters.map(point) };
}
const PARAMETERS = [0, 0.11, 0.35, 0.5, 0.8, 1.05, 1.3, 1.5, 1.7, 2.0, 2.25, 2.5, 2.8, 3.0];
const WIDE = { minimum: [-2, -2, -1] as Vec3Tuple, maximum: [2, 2, 1] as Vec3Tuple };

function smoothCurves(spec: FunctionCurveGeometrySpec): FunctionCurveSplineCurve[] {
  const result = functionCurvePolylines(oc, spec);
  if (result.status !== 'ready') throw new Error(JSON.stringify(result));
  return result.curves.map((curve): FunctionCurveSplineCurve => {
    if (curve.degree !== 3 || curve.mode !== 'control' || curve.closed !== false || curve.knots === undefined) {
      throw new Error('Expected a smooth curve');
    }
    return { kind: curve.kind, mode: curve.mode, closed: curve.closed, degree: curve.degree, knots: curve.knots, points: curve.points };
  });
}

describe('関数の滑らかな曲線を実CADのC1の3次Bスプラインとして作り、切断後も読み戻す', () => {
  it('実OCCTの曲線は3次・非有理・C1でありC2ではなく、全標本を通り、解析的な円から外れない', () => {
    const { spec, samples } = circleSpline(PARAMETERS);
    const [curve] = smoothCurves({ components: [samples], splines: [spec], bounds: WIDE });
    expect(curve.knots).toEqual(PARAMETERS);
    const owned = createAllocations();
    try {
      const edge = owned.keep(makeSplineEdge(oc, curve)), adaptor = owned.keep(new oc.BRepAdaptor_Curve_2(edge.edge));
      expect(Number(adaptor.Degree())).toBe(3); expect(adaptor.IsRational()).toBe(false);
      const spline = borrowHandle(owned.keep(adaptor.BSpline()));
      expect(spline.IsCN(1)).toBe(true); expect(spline.IsCN(2)).toBe(false);
      for (const [index, t] of PARAMETERS.entries()) {
        const value = owned.keep(adaptor.Value(t));
        expect(Math.hypot(value.X() - samples[index][0], value.Y() - samples[index][1], value.Z())).toBeLessThanOrEqual(1e-12);
      }
      for (let step = 0; step <= 3000; step++) {
        const value = owned.keep(adaptor.Value(3 * step / 3000));
        // Spans are at most 0.3 rad; the Hermite circle error there is about 2e-5 (sampled check, not a proof).
        expect(Math.abs(Math.hypot(value.X(), value.Y()) - 1)).toBeLessThanOrEqual(1e-4);
      }
    } finally { owned.release(); }
  });

  it('XYZ範囲での実切断は端の区間だけを分割し、端点は面上・曲線は範囲内・形は元のまま', () => {
    const { spec, samples } = circleSpline(PARAMETERS);
    const bounds = { minimum: [-0.5, -2, -1] as Vec3Tuple, maximum: [2, 0.9, 1] as Vec3Tuple };
    const curves = smoothCurves({ components: [samples], splines: [spec], bounds });
    expect(curves.length).toBeGreaterThanOrEqual(2);
    const owned = createAllocations();
    try {
      for (const curve of curves) {
        expect(curve.points).toHaveLength(2 * curve.knots.length);
        expect(curve.knots[0]).toBeGreaterThanOrEqual(0); expect(curve.knots.at(-1)).toBeLessThanOrEqual(3);
        const edge = owned.keep(makeSplineEdge(oc, curve)), adaptor = owned.keep(new oc.BRepAdaptor_Curve_2(edge.edge));
        const first = adaptor.FirstParameter(), last = adaptor.LastParameter();
        for (let step = 0; step <= 400; step++) {
          const value = owned.keep(adaptor.Value(first + (last - first) * step / 400));
          expect(value.X()).toBeGreaterThanOrEqual(-0.5 - 1e-6); expect(value.Y()).toBeLessThanOrEqual(0.9 + 1e-6);
          // The clipped piece keeps the original shape: it stays on the unit circle within the Hermite error.
          expect(Math.abs(Math.hypot(value.X(), value.Y()) - 1)).toBeLessThanOrEqual(1e-4);
        }
      }
    } finally { owned.release(); }
  });

  it('別々の成分は別の辺のまま返し、結ばない', () => {
    const left = circleSpline([0, 0.3, 0.6, 0.9]), right = circleSpline([2, 2.3, 2.6]);
    const curves = smoothCurves({ components: [left.samples, right.samples], splines: [left.spec, right.spec], bounds: WIDE });
    expect(curves.map((curve) => [curve.knots[0], curve.knots.at(-1)])).toEqual([[0, 0.9], [2, 2.6]]);
  });

  it('標本と食い違う・単調でない・Bezierと混在する指定を確保前に断り、中止はどの段でも中止で返す', () => {
    const { spec, samples } = circleSpline(PARAMETERS);
    const base: FunctionCurveGeometrySpec = { components: [samples], splines: [spec], bounds: WIDE };
    for (const bad of [
      { ...base, splines: [{ ...spec, knots: spec.knots.slice(1) }] },
      { ...base, splines: [{ ...spec, knots: [...spec.knots].reverse() }] },
      { ...base, splines: [{ ...spec, poles: [[9, 9, 9] as Vec3Tuple, ...spec.poles.slice(1)] }] },
      // Nonuniform knots: one inner pole moved by 1e-9 puts the native junction at knot 1 off its sample.
      { ...base, splines: [{ ...spec, poles: spec.poles.map((pole, n): Vec3Tuple => (n === 3 ? [pole[0], pole[1] + 1e-9, pole[2]] : pole)) }] },
      { ...base, splines: [] },
      { ...base, components: [], splines: [spec], bezier: [samples[0], samples[1], samples[2], samples[3]] as const },
    ]) expect(functionCurvePolylines(oc, bad).status).toBe('failed');
    expect(functionCurvePolylines(oc, base, () => true)).toEqual({ status: 'cancelled' });
    let count = 0;
    expect(functionCurvePolylines(oc, base, () => ++count > 3)).toEqual({ status: 'cancelled' });
    expect(functionCurvePolylines(oc, base).status).toBe('ready');
  });

  it('OCCTが区別できないほど近い節点の成分は、証明済みの折れ線へ戻す', () => {
    const tight = [1, 1 + 2 * Number.EPSILON, 1.3];
    const samples: Vec3Tuple[] = tight.map((t) => [Math.cos(t), Math.sin(t), 0]);
    const poles: Vec3Tuple[] = [samples[0], samples[0], samples[1], samples[1], samples[2], samples[2]];
    const result = functionCurvePolylines(oc, { components: [samples], splines: [{ knots: tight, poles }], bounds: WIDE });
    if (result.status !== 'ready') throw new Error(JSON.stringify(result));
    expect(result.curves.every((curve) => curve.degree === 1)).toBe(true);
  });

  it('接線0の節点だけで辺を分け、明示節点の3次は一様な曲線として読み替えない', () => {
    const knots = [0, 1, 2], points: Vec3Tuple[] = [[0, 0, 0], [0.3, 0.2, 0], [1, 1, 0], [1, 1, 0], [1.7, 0.2, 0], [2, 0, 0]];
    const pieces = [...continuousCurvePieces([{ kind: 'spline', mode: 'control', closed: false, degree: 3, knots, points }])];
    expect(pieces).toEqual([
      { kind: 'spline', mode: 'control', closed: false, degree: 3, knots: [0, 1], points: [[0, 0, 0], [0.3, 0.2, 0], [1, 1, 0], [1, 1, 0]] },
      { kind: 'spline', mode: 'control', closed: false, degree: 3, knots: [1, 2], points: [[1, 1, 0], [1, 1, 0], [1.7, 0.2, 0], [2, 0, 0]] },
    ]);
    const data = bsplineDataForSpline({ mode: 'control', degree: 3, knots, points });
    expect(data).toEqual({ poles: points, knots, multiplicities: [4, 2, 4], degree: 3, periodic: false });
    for (const bad of [
      { mode: 'control' as const, degree: 3 as const, knots, points: points.slice(1) },
      { mode: 'control' as const, degree: 3 as const, knots: [0, 2, 1], points },
      { mode: 'interpolate' as const, degree: 3 as const, knots, points },
      { mode: 'control' as const, degree: 3 as const, knots, points, closed: true },
      { mode: 'control' as const, degree: 3 as const, points },
    ]) expect(() => bsplineDataForSpline(bad)).toThrow();
    // Old uniform control splines keep their implicit knots exactly.
    expect(bsplineDataForSpline({ mode: 'control', points: points.slice(0, 5) })).toEqual(
      { poles: points.slice(0, 5), knots: [0, 1, 2], multiplicities: [4, 1, 4], degree: 3, periodic: false });
  });
});
