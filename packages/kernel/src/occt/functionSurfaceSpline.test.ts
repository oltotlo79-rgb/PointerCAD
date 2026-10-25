import type { TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { borrowHandle } from './borrowHandle.js';
import { makeCompound } from './transformShape.js';
import { FUNCTION_CLIP_BOUND_TOLERANCE, verifyFunctionShapeBounds, type FunctionClipBox } from './clipFunctionShape.js';
import { checkedFunctionSurfaceSpline, readFunctionSurfaceSpline, type FunctionSurfaceSplineSpec } from './functionSurfaceSpline.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeFunctionSurfaceBodies } from './makeFunctionSurfaceBodies.js';
import { isValidShape } from './solidMesh.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

/**
 * Independent test construction of the documented layout: z = x*y on nonuniform knots, with its exact Hermite data
 * (f_x = y, f_y = x, f_xy = 1). Pole (p, q) is the corner value plus signed thirds of the adjacent spans.
 */
function saddle(uKnots: readonly number[], vKnots: readonly number[]): FunctionSurfaceSplineSpec {
  const source = (knots: readonly number[], index: number): [number, number] => {
    if (index === 0) return [knots[0], 0];
    if (index === 2 * knots.length - 1) return [knots[knots.length - 1], 0];
    const span = Math.floor((index - 1) / 2), width = knots[span + 1] - knots[span];
    return index % 2 === 1 ? [knots[span], width / 3] : [knots[span + 1], -width / 3];
  };
  const poles: Vec3Tuple[] = [];
  for (let p = 0; p < 2 * uKnots.length; p++) for (let q = 0; q < 2 * vKnots.length; q++) {
    const [x, dx] = source(uKnots, p), [y, dy] = source(vKnots, q);
    poles.push([x + dx, y + dy, x * y + dx * y + dy * x + dx * dy]);
  }
  return { uKnots, vKnots, poles, errorBound: 0 };
}
const knots = [-2, -0.5, 1, 2];
const box: FunctionClipBox = { minimum: [-1.5, -1.5, -1.5], maximum: [1.5, 1.5, 1.5] };

describe('関数曲面の滑らかな面を実CADのC1双3次Bスプラインとして作り、箱で正しく切る', () => {
  it('実OCCTの面は3次・非有理・C1でC2ではなく、切断後も曲面上・箱の内側・+Z向きの法線を保つ', () => {
    // Verify the native typed conversion returns the same registered enum values.
    expect(oc.TopAbs.ShapeTypeFromString_1('EDGE')).toBe(oc.TopAbs_ShapeEnum.TopAbs_EDGE);
    expect(oc.TopAbs.ShapeTypeFromString_1('FACE')).toBe(oc.TopAbs_ShapeEnum.TopAbs_FACE);
    const spec = saddle(knots, knots);
    const result = makeFunctionSurfaceBodies(oc, { vertices: [], triangles: [], bounds: box, spline: spec });
    if (result.status !== 'bodies') throw new Error(JSON.stringify(result));
    const owner = createAllocations();
    try {
      expect(result.bodies).toHaveLength(1); expect(result.bodies[0].bodyKind).toBe('shell');
      const shape = result.bodies[0].shape;
      expect(isValidShape(oc, shape)).toBe(true);
      const faces = owner.keep(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_2(shape, faces, true, true);
      let checked = 0, centreInside = 0, mappedBoundaries = 0;
      for (let index = 1; index <= faces.Size(); index++) {
        const item = owner.keep(faces.FindKey(index));
        if (item.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
        const native = readFunctionSurfaceSpline(oc, item);
        expect(native).toMatchObject({ uDegree: 3, vDegree: 3, rational: false, c1: true, c2: false });
        expect(native?.u.map(entry => entry.multiplicity)).toEqual([4, 2, 2, 4]);
        expect(native?.v.map(entry => entry.multiplicity)).toEqual([4, 2, 2, 4]);
        expect(native?.u.map(entry => entry.knot)).toEqual(spec.uKnots);
        expect(native?.v.map(entry => entry.knot)).toEqual(spec.vKnots);
        const face = owner.keep(oc.TopoDS.Face_1(item)), adaptor = owner.keep(new oc.BRepAdaptor_Surface_2(face, true));
        // Check the boundary on the actual surface as well as its separate 3D
        // edge representation. Their stored topology tolerance can exceed1e-6.
        const trimEdges = owner.keep(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_1(face, oc.TopAbs.ShapeTypeFromString_1('EDGE'), trimEdges);
        for (let edgeIndex = 1; edgeIndex <= trimEdges.Size(); edgeIndex++) {
          const edge = owner.keep(oc.TopoDS.Edge_1(owner.keep(trimEdges.FindKey(edgeIndex))));
          const mapped = owner.keep(new oc.BRepAdaptor_Curve_3(edge, face));
          const mappedBounds = owner.keep(new oc.Bnd_Box_1());
          oc.BndLib_Add3dCurve.AddOptimal_1(mapped, 1e-8, mappedBounds);
          expect(mappedBounds.IsVoid()).toBe(false);
          const low = owner.keep(mappedBounds.CornerMin()), high = owner.keep(mappedBounds.CornerMax());
          [[low.X(), high.X()], [low.Y(), high.Y()], [low.Z(), high.Z()]].forEach(([min, max], axis) => {
            expect(min).toBeGreaterThanOrEqual(box.minimum[axis] - FUNCTION_CLIP_BOUND_TOLERANCE);
            expect(max).toBeLessThanOrEqual(box.maximum[axis] + FUNCTION_CLIP_BOUND_TOLERANCE);
          });
          mappedBoundaries++;
        }
        const nativeSurface = borrowHandle(owner.keep(adaptor.BSpline()));
        expect(Number(nativeSurface.NbUPoles())).toBe(2 * spec.uKnots.length);
        expect(Number(nativeSurface.NbVPoles())).toBe(2 * spec.vKnots.length);
        for (let u = 1; u <= nativeSurface.NbUPoles(); u++) for (let v = 1; v <= nativeSurface.NbVPoles(); v++) {
          const pole = owner.keep(nativeSurface.Pole(u, v));
          expect([pole.X(), pole.Y(), pole.Z()]).toEqual(spec.poles[(u - 1) * 2 * spec.vKnots.length + v - 1]);
        }
        // Same complete native polynomial, but a different face domain after clipping.
        for (const [u, v, expected] of [[0, 0, 'inside'], [1.4, 1.4, 'outside']] as const) {
          const point = owner.keep(new oc.gp_Pnt2d_3(u, v));
          const classifier = owner.keep(new oc.BRepClass_FaceClassifier_3(face, point, 1e-9, false, 0.1));
          if (expected === 'outside') expect(classifier.State()).toBe(oc.TopAbs_State.TopAbs_OUT);
          else if (classifier.State() === oc.TopAbs_State.TopAbs_IN || classifier.State() === oc.TopAbs_State.TopAbs_ON) centreInside++;
        }
        const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
        for (let a = 1; a < 10; a++) for (let b = 1; b < 10; b++) {
          const u = adaptor.FirstUParameter() + (adaptor.LastUParameter() - adaptor.FirstUParameter()) * a / 10;
          const v = adaptor.FirstVParameter() + (adaptor.LastVParameter() - adaptor.FirstVParameter()) * b / 10;
          const point = owner.keep(new oc.gp_Pnt_1()), du = owner.keep(new oc.gp_Vec_1()), dv = owner.keep(new oc.gp_Vec_1());
          adaptor.D1(u, v, point, du, dv);
          // The native surface is exactly the saddle in its own parameters.
          expect(Math.abs(point.Z() - point.X() * point.Y())).toBeLessThanOrEqual(1e-9);
          const normalZ = du.X() * dv.Y() - du.Y() * dv.X();
          expect((reversed ? -normalZ : normalZ) > 0).toBe(true);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(0);
      expect(centreInside).toBeGreaterThan(0);
      expect(mappedBoundaries).toBeGreaterThan(0);
      verifyFunctionShapeBounds(oc, shape, box, owner);
      // Independent whole-domain oracle for this exact saddle: x, y and x*y
      // are harmonic, so maxima/minima on a compact trimmed domain occur on
      // its boundary. The native poles above prove the entire underlying
      // polynomial; complete native trimmed curve bounds cover the boundary.
      const boundary: TopoDS_Shape[] = [];
      for (let index = 1; index <= faces.Size(); index++) {
        const item = owner.keep(faces.FindKey(index));
        if (item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_EDGE) boundary.push(item);
      }
      expect(boundary.length).toBeGreaterThan(0);
      const edges = owner.keep(makeCompound(oc, boundary));
      const bounds = owner.keep(new oc.Bnd_Box_1());
      oc.BRepBndLib.AddOptimal(edges.shape, bounds, false, false); bounds.SetGap(0);
      const low = owner.keep(bounds.CornerMin()), high = owner.keep(bounds.CornerMax());
      [[low.X(), high.X()], [low.Y(), high.Y()], [low.Z(), high.Z()]].forEach(([min, max], axis) => {
        expect(min).toBeGreaterThanOrEqual(box.minimum[axis] - FUNCTION_CLIP_BOUND_TOLERANCE);
        expect(max).toBeLessThanOrEqual(box.maximum[axis] + FUNCTION_CLIP_BOUND_TOLERANCE);
      });
    } finally { owner.release(); result.delete(); }
  });

  it('未切断の同じ曲面を範囲内と誤認せず、実際の切断後だけ全体の範囲を認める', () => {
    const broad: FunctionClipBox = { minimum: [-3, -3, -5], maximum: [3, 3, 5] };
    const original = makeFunctionSurfaceBodies(oc, { vertices: [], triangles: [], bounds: broad, spline: saddle(knots, knots) });
    if (original.status !== 'bodies') throw new Error(JSON.stringify(original));
    const owner = createAllocations();
    try {
      expect(() => verifyFunctionShapeBounds(oc, original.bodies[0].shape, box, owner)).toThrow('範囲');
      expect(isValidShape(oc, original.bodies[0].shape)).toBe(true);
    } finally { owner.release(); original.delete(); }
  });

  it('境界の全曲線が範囲内でも内部だけが盛り上がる連続面の越境を検出する', () => {
    // Exact degree-elevated tensor polynomial z=(1-x²)(1-y²).
    // Every boundary edge has z=0, while the interior maximum is z=1.
    const coordinates = [-1, -1 / 3, 1 / 3, 1], quadratic = [0, 4 / 3, 4 / 3, 0];
    const poles: Vec3Tuple[] = coordinates.flatMap((x, u) => coordinates.map((y, v): Vec3Tuple => [x, y, quadratic[u] * quadratic[v]]));
    const spline: FunctionSurfaceSplineSpec = { uKnots: [-1, 1], vKnots: [-1, 1], poles, errorBound: 0 };
    const broad: FunctionClipBox = { minimum: [-2, -2, -1], maximum: [2, 2, 2] };
    const narrow: FunctionClipBox = { minimum: [-2, -2, -1], maximum: [2, 2, 0.5] };
    const original = makeFunctionSurfaceBodies(oc, { vertices: [], triangles: [], bounds: broad, spline });
    if (original.status !== 'bodies') throw new Error(JSON.stringify(original));
    const owner = createAllocations();
    try {
      expect(() => verifyFunctionShapeBounds(oc, original.bodies[0].shape, narrow, owner)).toThrow('範囲');
      expect(isValidShape(oc, original.bodies[0].shape)).toBe(true);
      const trimmed = makeFunctionSurfaceBodies(oc, { vertices: [], triangles: [], bounds: narrow, spline });
      if (trimmed.status !== 'bodies') throw new Error(JSON.stringify(trimmed));
      const trimmedOwner = createAllocations();
      try {
        expect(trimmed.bodies).toHaveLength(1);
        expect(isValidShape(oc, trimmed.bodies[0].shape)).toBe(true);
        expect(() => verifyFunctionShapeBounds(oc, trimmed.bodies[0].shape, narrow, trimmedOwner)).not.toThrow();
        const faces = trimmedOwner.keep(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_1(trimmed.bodies[0].shape, oc.TopAbs.ShapeTypeFromString_1('FACE'), faces);
        expect(faces.Size()).toBe(1);
        const face = trimmedOwner.keep(oc.TopoDS.Face_1(trimmedOwner.keep(faces.FindKey(1))));
        const centre = trimmedOwner.keep(new oc.gp_Pnt2d_3(0, 0));
        const retained = trimmedOwner.keep(new oc.gp_Pnt2d_3(0.9, 0));
        expect(trimmedOwner.keep(new oc.BRepClass_FaceClassifier_3(face, centre, 1e-9, false, 1e-9)).State())
          .toBe(oc.TopAbs_State.TopAbs_OUT);
        expect(trimmedOwner.keep(new oc.BRepClass_FaceClassifier_3(face, retained, 1e-9, false, 1e-9)).State())
          .toBe(oc.TopAbs_State.TopAbs_IN);
      } finally { try { trimmedOwner.release(); } finally { trimmed.delete(); } }
    } finally { owner.release(); original.delete(); }
  });

  it('放物面の全UV矩形を実際の円形trim領域と混同せず、Z上限2の切断を保証する', () => {
    const coordinates = [-2, -2 / 3, 2 / 3, 2], square = [4, -4 / 3, -4 / 3, 4];
    const poles: Vec3Tuple[] = coordinates.flatMap((x, u) => coordinates.map((y, v): Vec3Tuple => [x, y, square[u] + square[v]]));
    const spline: FunctionSurfaceSplineSpec = { uKnots: [-2, 2], vKnots: [-2, 2], poles, errorBound: 0 };
    const limits: FunctionClipBox = { minimum: [-2, -2, -0.1], maximum: [2, 2, 2] };
    const result = makeFunctionSurfaceBodies(oc, { vertices: [], triangles: [], bounds: limits, spline });
    if (result.status !== 'bodies') throw new Error(JSON.stringify(result));
    const owner = createAllocations();
    try {
      expect(result.bodies).toHaveLength(1);
      const shape = result.bodies[0].shape;
      expect(isValidShape(oc, shape)).toBe(true);
      expect(() => verifyFunctionShapeBounds(oc, shape, limits, owner)).not.toThrow();
      const faces = owner.keep(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_1(shape, oc.TopAbs.ShapeTypeFromString_1('FACE'), faces);
      expect(faces.Size()).toBe(1);
      const face = owner.keep(oc.TopoDS.Face_1(owner.keep(faces.FindKey(1))));
      const adaptor = owner.keep(new oc.BRepAdaptor_Surface_2(face, true));
      for (const [x, y, inside] of [[0, 0, true], [1, 0, true], [1.4, 1.4, false]] as const) {
        const point = owner.keep(adaptor.Value(x, y));
        expect(Math.abs(point.Z() - x * x - y * y)).toBeLessThanOrEqual(1e-9);
        const parameter = owner.keep(new oc.gp_Pnt2d_3(x, y));
        const state = owner.keep(new oc.BRepClass_FaceClassifier_3(face, parameter, 1e-9, false, 1e-9)).State();
        expect(state).toBe(inside ? oc.TopAbs_State.TopAbs_IN : oc.TopAbs_State.TopAbs_OUT);
      }
    } finally { owner.release(); result.delete(); }
  });

  it('二つの内部極大を切った複数の穴と、穴の間に残る面を保つ', () => {
    const uKnots = [-2, -1, 0, 1, 2], vKnots = [-1, 1];
    const x = [-2, -5 / 3, -4 / 3, -2 / 3, -1 / 3, 1 / 3, 2 / 3, 4 / 3, 5 / 3, 2];
    const y = [-1, -1 / 3, 1 / 3, 1], heights = [0, 0, 1, 1, 0, 0, 1, 1, 0, 0], quadratic = [0, 4 / 3, 4 / 3, 0];
    const poles: Vec3Tuple[] = x.flatMap((coordinate, row) => y.map((value, column): Vec3Tuple => [coordinate, value, heights[row] * quadratic[column]]));
    const spline: FunctionSurfaceSplineSpec = { uKnots, vKnots, poles, errorBound: 0 };
    const limits: FunctionClipBox = { minimum: [-3, -2, -1], maximum: [3, 2, 0.9] };
    const result = makeFunctionSurfaceBodies(oc, { vertices: [], triangles: [], bounds: limits, spline });
    if (result.status !== 'bodies') throw new Error(JSON.stringify(result));
    const owner = createAllocations();
    try {
      expect(result.bodies).toHaveLength(1);
      const shape = result.bodies[0].shape;
      expect(isValidShape(oc, shape)).toBe(true);
      expect(() => verifyFunctionShapeBounds(oc, shape, limits, owner)).not.toThrow();
      const faces = owner.keep(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_1(shape, oc.TopAbs.ShapeTypeFromString_1('FACE'), faces);
      expect(faces.Size()).toBe(1);
      const face = owner.keep(oc.TopoDS.Face_1(owner.keep(faces.FindKey(1))));
      const adaptor = owner.keep(new oc.BRepAdaptor_Surface_2(face, true));
      for (const [u, expectedZ, inside] of [[-1, 1, false], [0, 0, true], [1, 1, false]] as const) {
        const point = owner.keep(adaptor.Value(u, 0));
        expect(Math.abs(point.Z() - expectedZ)).toBeLessThanOrEqual(1e-9);
        const parameter = owner.keep(new oc.gp_Pnt2d_3(u, 0));
        const state = owner.keep(new oc.BRepClass_FaceClassifier_3(face, parameter, 1e-9, false, 1e-9)).State();
        expect(state).toBe(inside ? oc.TopAbs_State.TopAbs_IN : oc.TopAbs_State.TopAbs_OUT);
      }
    } finally { owner.release(); result.delete(); }
  });

  it('箱の外にある面は空として返し、取消はどの段でも取消で返す', () => {
    const away: FunctionClipBox = { minimum: [5, 5, 5], maximum: [6, 6, 6] };
    expect(makeFunctionSurfaceBodies(oc, { vertices: [], triangles: [], bounds: away, spline: saddle(knots, knots) })).toEqual({ status: 'empty' });
    expect(makeFunctionSurfaceBodies(oc, { vertices: [], triangles: [], bounds: box, spline: saddle(knots, knots) }, () => true))
      .toEqual({ status: 'cancelled' });
  });

  it('節点・極の数・有限性・項目の崩れを、OCCTの確保より前に断る', () => {
    const spec = saddle(knots, knots);
    for (const bad of [
      { ...spec, uKnots: [-2, -0.5, -0.5, 2] },
      { ...spec, vKnots: [-2, 1, -0.5, 2] },
      { ...spec, uKnots: [-2, 1 + 1e-17, 1, 2] },
      { ...spec, poles: spec.poles.slice(1) },
      { ...spec, poles: spec.poles.map((pole, n): Vec3Tuple => (n === 7 ? [pole[0], Number.POSITIVE_INFINITY, pole[2]] : pole)) },
      { ...spec, errorBound: -1 },
      { uKnots: spec.uKnots, vKnots: spec.vKnots, poles: spec.poles },
    ]) {
      expect(() => checkedFunctionSurfaceSpline(bad)).toThrow();
      expect(() => makeFunctionSurfaceBodies(oc, { vertices: [], triangles: [], bounds: box, spline: bad as FunctionSurfaceSplineSpec })).toThrow();
    }
  });
});
