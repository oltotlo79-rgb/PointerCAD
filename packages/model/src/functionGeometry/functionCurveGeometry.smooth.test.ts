import { beforeAll, describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { createFunctionMathSource, createMathBackend } from '@pointercad/expression/math/worker';
import { booleanOp, createAllocations, createKernelApi, isValidShape, makeBox, makeExtrudeSolid, makePlanarFace, makeSplineEdge,
  measureArea } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { borrowHandle } from '../../../kernel/src/occt/borrowHandle.js';
import { smoothFunctionCurve } from '../../../expression/src/math/smoothFunctionCurve.js';
import type { FunctionCurveSample } from '../../../expression/src/math/adaptiveFunctionCurve.js';
import { createDirectKernelBridge, toCurveSpec, fromCurveSpec } from '../kernelBridge.js';
import { keyCurveList } from '../part/cacheKey.js';
import { sheetBezierSpans } from '../sheetMetal/bezierSpans.js';
import { mirrorTransform, transformCurve } from '../sketch/copyMath.js';
import { DEFAULT_FACE_COLOR } from '../sketch/createSketchDocument.js';
import { resolveSketch } from '../sketch/resolveSketch.js';
import { reverseSpline, sampleSpline, splineCurveData } from '../sketch/splineMath.js';
import type { ResolvedSpline, SketchDocument, SketchFaceFeature } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { createFunctionCurve } from './createFunctionCurve.js';
import { readFunctionCurveGeometry, type FunctionCurveGeometryInput } from './functionCurveGeometry.js';
import { FUNCTION_DEFINITION_FORMAT, type FunctionDefinition } from './functionDefinitionTypes.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

/** Nonuniform circle samples; the proved chord bound of a unit circle is h^2 / 8. */
const PARAMETERS = [0, 0.1, 0.25, 0.45, 0.6, 0.85, 1.0, 1.2, 1.45, 1.6, 1.85, 2.05, 2.3, 2.5];
const samples: FunctionCurveSample[] = PARAMETERS.map(t => ({ parameter: t, point: [Math.cos(t), Math.sin(t), 0] }));
const chord = Math.max(...PARAMETERS.slice(1).map((t, n) => (t - PARAMETERS[n]) ** 2 / 8));
const smooth = smoothFunctionCurve([samples], chord, 0.05);
if (smooth === null) throw new Error('Expected a proved smooth circle');
const bounds = { minimum: [-2, -2, -1] as Vec3, maximum: [2, 2, 1] as Vec3 };
const input: FunctionCurveGeometryInput = { featureId: 'smooth', bounds, components: [samples.map(sample => sample.point)],
  splines: smooth.splines };

async function smoothCurve(request = input): Promise<ResolvedSpline> {
  const bridge = createDirectKernelBridge(createKernelApi(() => Promise.resolve(oc)));
  try {
    const result = await bridge.functionSketchCurves(request);
    if (result.status !== 'ready' || result.curves.length !== 1) throw new Error(JSON.stringify(result));
    return result.curves[0];
  } finally { bridge.dispose(); }
}

describe('明示節点の滑らかな関数曲線を、解決・変換・反転・鍵・板金・CADで一様な曲線と取り違えない', () => {
  it('ブリッジ往復・再計算で節点と制御点が保たれ、実CADの曲線はC1でC2ではない', async () => {
    const curve = await smoothCurve();
    expect(curve.degree).toBe(3); expect(curve.knots).toEqual(PARAMETERS);
    expect(curve.points).toHaveLength(2 * PARAMETERS.length);
    expect(await smoothCurve()).toEqual(curve); // Regenerated from the same definition: no stored derived state needed.
    expect(fromCurveSpec(toCurveSpec(curve), 'copy')).toEqual({ ...curve, featureId: 'copy' });
    const owned = createAllocations();
    try {
      const spec = toCurveSpec(curve);
      if (spec.kind !== 'spline') throw new Error('Expected spline');
      const edge = owned.keep(makeSplineEdge(oc, spec)), adaptor = owned.keep(new oc.BRepAdaptor_Curve_2(edge.edge));
      const native = borrowHandle(owned.keep(adaptor.BSpline()));
      expect(Number(native.Degree())).toBe(3); expect(native.IsCN(1)).toBe(true); expect(native.IsCN(2)).toBe(false);
      // Sampled check against the analytic circle; the proof is smooth.errorBound.
      for (const point of sampleSpline(curve)) expect(Math.abs(Math.hypot(point[0], point[1]) - 1)).toBeLessThanOrEqual(smooth.errorBound);
    } finally { owned.release(); }
  });

  it('鏡像は節点を保ち、反転は節点も写して同じ形を逆向きにたどる', async () => {
    const curve = await smoothCurve();
    const mirrored = transformCurve(mirrorTransform([0, 0, 0], [1, 0, 0]), curve, 'mirror');
    if (mirrored.kind !== 'spline') throw new Error('Expected spline');
    expect(mirrored.knots).toEqual(curve.knots);
    sampleSpline(mirrored).forEach((point, n) => {
      const original = sampleSpline(curve)[n];
      expect(point[0]).toBeCloseTo(-original[0], 12); expect(point[1]).toBeCloseTo(original[1], 12);
    });
    const reversed = reverseSpline(curve), twice = reverseSpline(reversed);
    expect(twice.points).toEqual(curve.points);
    twice.knots?.forEach((knot, n) => expect(knot).toBeCloseTo(PARAMETERS[n], 12));
    const forward = sampleSpline(curve), backward = sampleSpline(reversed).reverse();
    expect(backward).toHaveLength(forward.length);
    backward.forEach((point, n) => point.forEach((value, axis) => expect(value).toBeCloseTo(forward[n][axis], 12)));
  });

  it('形状キャッシュの鍵は節点を含み、同じ点の一様な3次・一次の折れ線とは別になる', async () => {
    const curve = await smoothCurve();
    const uniform: ResolvedSpline = { kind: 'spline', featureId: curve.featureId, mode: 'control', closed: false, points: curve.points };
    const linear: ResolvedSpline = { ...uniform, degree: 1 };
    const shifted: ResolvedSpline = { ...curve, knots: curve.knots?.map(knot => knot + 1) };
    const keys = [keyCurveList([curve]), keyCurveList([uniform]), keyCurveList([linear]), keyCurveList([shifted])];
    expect(new Set(keys).size).toBe(4);
    const mapped = toCurveSpec(curve);
    if (mapped.kind !== 'spline') throw new Error('Expected spline');
    expect(keyCurveList([curve])).toEqual(keyCurveList([mapped]));
  });

  it('板金のBezier区間は節点ごとに厳密で、区間の両端は曲線上の点になる', async () => {
    const curve = await smoothCurve();
    const spans = sheetBezierSpans(curve);
    if (spans === null) throw new Error('Expected spans');
    expect(spans).toHaveLength(PARAMETERS.length - 1);
    for (const span of spans) for (const end of [span.poles[0], span.poles[3]]) {
      expect(Math.abs(Math.hypot(end[0], end[1]) - 1)).toBeLessThanOrEqual(1e-12 + smooth.errorBound);
    }
    spans.forEach((span, n) => span.poles[0].forEach((value, axis) => expect(value).toBeCloseTo(samples[n].point[axis], 12)));
  });

  it('崩れた明示節点の記録は解けないものとして断り、要求に無い滑らかな応答も受け取らない', async () => {
    const curve = await smoothCurve();
    for (const bad of [{ ...curve, points: curve.points.slice(1) }, { ...curve, knots: curve.knots?.slice().reverse() },
      { ...curve, closed: true }, { ...curve, mode: 'interpolate' as const }, { ...curve, degree: undefined }]) {
      expect(splineCurveData(bad)).toBeNull();
    }
    const reply = { status: 'ready', curves: [{ kind: 'spline', mode: 'control', degree: 3, closed: false, knots: curve.knots, points: curve.points }] };
    expect(readFunctionCurveGeometry(reply, input).status).toBe('ready');
    expect(readFunctionCurveGeometry(reply, { ...input, splines: undefined }).status).toBe('failed');
    const outside = curve.points.map((point, n): Vec3 => n === 0 ? [5, 0, 0] : point);
    expect(readFunctionCurveGeometry({ status: 'ready', curves: [{ ...reply.curves[0], points: outside }] }, input).status).toBe('failed');
    expect(readFunctionCurveGeometry({ status: 'ready', curves: [{ ...reply.curves[0], knots: [-9, ...(curve.knots ?? []).slice(1)] }] }, input).status)
      .toBe('failed');
  });

  it('閉じた媒介変数の輪は実CADの面・面積・メッシュになり、鏡像・反転後も端が一致する（継ぎ目の周期性は主張しない）', async () => {
    // Nonuniform full turn; the last sample is the same point as the first, as a closed parametric loop gives.
    const turns = [0, 0.2, 0.55, 0.9, 1.3, 1.6, 2.0, 2.4, 2.75, 3.1, 3.5, 3.9, 4.3, 4.6, 5.0, 5.4, 5.75, 6.05, 2 * Math.PI];
    const loop: FunctionCurveSample[] = turns.map((t, n) => ({ parameter: t,
      point: n === turns.length - 1 ? [1, 0, 0] : [Math.cos(t), Math.sin(t), 0] }));
    const bound = Math.max(...turns.slice(1).map((t, n) => (t - turns[n]) ** 2 / 8));
    const proved = smoothFunctionCurve([loop], bound, 0.08);
    if (proved === null) throw new Error('Expected a proved closed loop');
    const curve = await smoothCurve({ featureId: 'loop', bounds, components: [loop.map(sample => sample.point)], splines: proved.splines });
    expect(curve.closed).toBe(false); // Clamped, not periodic: no seam continuity is claimed.
    expect(curve.points[0]).toEqual(curve.points[curve.points.length - 1]);
    // Measured, not claimed: the seam tangents of this sampled loop differ slightly.
    const last = curve.points.length - 1, knots = curve.knots ?? [];
    const startSlope = (curve.points[1][1] - curve.points[0][1]) * 3 / (knots[1] - knots[0]);
    const endSlope = (curve.points[last][1] - curve.points[last - 1][1]) * 3 / (knots[knots.length - 1] - knots[knots.length - 2]);
    expect(Number.isFinite(startSlope - endSlope)).toBe(true);
    const face = makePlanarFace(oc, [toCurveSpec(curve)]);
    try {
      expect(face.boundaryEdgeCount).toBe(1);
      // The enclosed area differs from pi by at most the perimeter times the proved distance bound.
      expect(Math.abs(measureArea(oc, face.face) - Math.PI)).toBeLessThanOrEqual(2 * Math.PI * (1 + proved.errorBound) * proved.errorBound);
    } finally { face.delete(); }
    const bridge = createDirectKernelBridge(createKernelApi(() => Promise.resolve(oc)));
    try {
      const mesh = await bridge.tessellateSketchFaces([{ featureId: 'loop-face', color: '#abcdef', curves: [curve] }]);
      expect(mesh.failures).toEqual([]); expect(mesh.mesh.faces).toHaveLength(1);
    } finally { bridge.dispose(); }
    const mirrored = transformCurve(mirrorTransform([0, 0, 0], [0, 1, 0]), curve, 'mirror');
    if (mirrored.kind !== 'spline') throw new Error('Expected spline');
    const reversed = reverseSpline(curve);
    for (const closed of [mirrored, reversed]) {
      expect(closed.points[0]).toEqual(closed.points[closed.points.length - 1]);
      const sampled = sampleSpline(closed);
      expect(sampled[0]).toEqual(sampled[sampled.length - 1]);
    }
  });

  it('関数の閉じた輪1本はスケッチの面になり、押し出しの差で箱から4分の1の柱を削る(EX04)', async () => {
    // The same nonuniform full turn as above; the last sample is the first point, as a closed parametric loop gives.
    const turns = [0, 0.2, 0.55, 0.9, 1.3, 1.6, 2.0, 2.4, 2.75, 3.1, 3.5, 3.9, 4.3, 4.6, 5.0, 5.4, 5.75, 6.05, 2 * Math.PI];
    const loop: FunctionCurveSample[] = turns.map((t, n) => ({ parameter: t,
      point: n === turns.length - 1 ? [1, 0, 0] : [Math.cos(t), Math.sin(t), 0] }));
    const bound = Math.max(...turns.slice(1).map((t, n) => (t - turns[n]) ** 2 / 8));
    const proved = smoothFunctionCurve([loop], bound, 0.08);
    if (proved === null) throw new Error('Expected a proved closed loop');
    const curve = await smoothCurve({ featureId: 'loop', bounds, components: [loop.map(sample => sample.point)], splines: proved.splines });
    const e = proved.errorBound;
    for (const point of sampleSpline(curve)) expect(Math.abs(Math.hypot(point[0], point[1]) - 1)).toBeLessThanOrEqual(e);
    // The actual public sketch path: a function-curve feature and a face whose boundary is that one curve.
    const backend = createMathBackend(), value = expressionValueFromNumber;
    const inT = (text: string) => createFunctionMathSource(text, 'text', 'radian', { axes: [], parameters: ['T'], coefficients: [] }, backend);
    const definition: FunctionDefinition = { format: FUNCTION_DEFINITION_FORMAT,
      bounds: { X: { min: value(-2), max: value(2) }, Y: { min: value(-2), max: value(2) }, Z: { min: value(-1), max: value(1) } },
      tolerance: value(0.08),
      formula: { kind: 'parametric-curve', outputs: { X: inT('cos(T)'), Y: inT('sin(T)'), Z: inT('0') }, T: { min: value(0), max: value(2 * Math.PI) } } };
    const empty: SketchDocument = { id: 'sketch-1', name: 'スケッチ1', features: [] };
    const fn = createFunctionCurve(empty, definition);
    const face: SketchFaceFeature = { id: 'face-1', name: '面1', planeId: 'xy', kind: 'face', boundary: [{ featureId: fn.id }], color: DEFAULT_FACE_COLOR };
    const sketch: SketchDocument = { ...empty, features: [fn, face] };
    const resolveWith = (remembered: ResolvedSpline) => resolveSketch(sketch, { functionCurves: id => (id === fn.id ? [remembered] : null) });
    const resolved = resolveWith(curve);
    expect(resolved.errors).toEqual([]);
    expect(resolved.faces).toHaveLength(1);
    expect(resolved.faces[0].curves).toHaveLength(1);
    expect(resolved.faces[0].curves[0]).toMatchObject({ kind: 'spline', closed: false, knots: curve.knots, points: curve.points });
    // Cut: extrude the resolved face through the 4 x 4 x 2 box at the origin. The curve stays within e of the unit circle,
    // so the removed quarter prism of height 2 lies between (pi/2)(1 - e)^2 and (pi/2)(1 + e)^2.
    const owned = createAllocations();
    try {
      const profile = resolved.faces[0].curves.map(item => toCurveSpec(item));
      const tool = owned.keep(makeExtrudeSolid(oc, { kind: 'extrude', profile, direction: [0, 0, 1], distance: 3 }));
      const box = owned.keep(makeBox(oc, { dx: 4, dy: 4, dz: 2 }));
      const cut = owned.keep(booleanOp(oc, 'subtract', box.shape, tool.shape));
      expect(isValidShape(oc, cut.shape)).toBe(true);
      expect(Math.abs(32 - cut.volume - Math.PI / 2)).toBeLessThanOrEqual((Math.PI / 2) * (2 * e + e * e));
    } finally { owned.release(); }
    // +0 and -0 are the same coordinate; any real gap, a nonplanar loop or a malformed knot array is still refused.
    const last = curve.points.length - 1;
    const withEnd = (end: Vec3): ResolvedSpline => ({ ...curve, points: curve.points.map((point, n): Vec3 => (n === last ? end : point)) });
    const [x0, y0, z0] = curve.points[0];
    expect(z0).toBe(0);
    expect(resolveWith(withEnd([x0, y0, -0])).faces).toHaveLength(1);
    const codes = (remembered: ResolvedSpline) => {
      const outcome = resolveWith(remembered);
      expect(outcome.faces).toEqual([]);
      return outcome.errors.map(item => item.code);
    };
    expect(codes(withEnd([x0 + 1e-12, y0, z0]))).toEqual(['notClosed']);
    expect(codes({ ...curve, points: curve.points.map((point, n): Vec3 => (n === 5 ? [point[0], point[1], 0.5] : point)) }))
      .toEqual(['notPlanar']);
    expect(codes({ ...curve, knots: curve.knots?.slice().reverse() })).toEqual(['notClosed']);
  });

  it('既存の一様・一次の鍵の文字列は変えず、1e-9未満だけ違う節点でも別の鍵になる', async () => {
    const legacy: ResolvedSpline = { kind: 'spline', featureId: 'legacy', mode: 'control', closed: false, points: [[0, 0, 0], [1, 2, 0]] };
    expect(keyCurveList([legacy])).toBe('1:[spline(control|false|2:[0.000000000,0.000000000,0.000000000,1.000000000,2.000000000,0.000000000])]');
    expect(keyCurveList([{ ...legacy, degree: 1 }]))
      .toBe('1:[spline(control|false|degree:1|2:[0.000000000,0.000000000,0.000000000,1.000000000,2.000000000,0.000000000])]');
    const curve = await smoothCurve();
    const knots = curve.knots ?? [];
    const close: ResolvedSpline = { ...curve, knots: knots.map((knot, n) => (n === 1 ? knot + 1e-12 : knot)) };
    expect(splineCurveData(close)).not.toBeNull();
    expect(keyCurveList([close])).not.toEqual(keyCurveList([curve]));
    expect(keyCurveList([{ ...curve, knots: knots.map(knot => (knot === 0 ? -0 : knot)) }])).toEqual(keyCurveList([curve]));
  });
});
