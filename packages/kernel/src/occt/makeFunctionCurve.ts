/** Turn certified piecewise-linear samples into CAD edges, then clip the actual geometry. */
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { makeCompound } from './transformShape.js';
import { makeSplineEdge } from './makeSplineEdge.js';
import { clipFunctionShape, validateFunctionClipBox, type FunctionClipBox, type FunctionClipResult } from './clipFunctionShape.js';

export interface FunctionCurveGeometrySpec {
  readonly components: readonly (readonly Vec3Tuple[])[];
  /** An exact polynomial whose whole control hull lies inside the XYZ box. */
  readonly bezier?: readonly [Vec3Tuple, Vec3Tuple, Vec3Tuple, Vec3Tuple];
  readonly bounds: FunctionClipBox;
}
export type FunctionCurveGeometryResult = FunctionClipResult | { readonly status: 'cancelled' };
function array(value: unknown): value is readonly unknown[] { return Array.isArray(value); }

function checkedBezier(spec: FunctionCurveGeometrySpec): readonly Vec3Tuple[] | undefined {
  if (spec.bezier === undefined) return undefined;
  if (!array(spec.bezier) || spec.bezier.length !== 4 || spec.components.length !== 0) throw new Error('関数曲線の制御点の指定が不正です。');
  for (const point of spec.bezier) {
    if (!array(point) || point.length !== 3) throw new Error('関数曲線の制御点にXYZを指定してください。');
    for (let axis = 0; axis < 3; axis++) {
      const coordinate: unknown = point[axis];
      if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)
        || coordinate < spec.bounds.minimum[axis] || coordinate > spec.bounds.maximum[axis]) throw new Error('関数曲線の制御点がXYZ範囲に収まりません。');
    }
  }
  if (spec.bezier[0].every((coordinate, axis) => coordinate === spec.bezier?.[3][axis])) throw new Error('関数曲線の始点と終点が一致しています。');
  return spec.bezier;
}

/** Before allocating any WASM object. A large sample buffer cannot bypass the Worker's point budget. */
function checkedComponents(spec: FunctionCurveGeometrySpec): readonly (readonly Vec3Tuple[])[] {
  validateFunctionClipBox(spec.bounds);
  if (!array(spec.components) || spec.components.length > 4096) throw new Error('関数曲線の成分数が上限を超えています。');
  let count = 0;
  const components: Vec3Tuple[][] = [];
  for (const input of spec.components) {
    if (!array(input) || input.length < 2 || (count += input.length) > 200_000) throw new Error('関数曲線の点数を確認してください。');
    const points: Vec3Tuple[] = [];
    for (const entry of input) {
      if (!array(entry) || entry.length !== 3) throw new Error('関数曲線の各点にXYZを指定してください。');
      const x: unknown = entry[0], y: unknown = entry[1], z: unknown = entry[2];
      if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number'
        || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('関数曲線の座標は有限の実数にしてください。');
      const previous = points.at(-1);
      // Only exact duplicate positions are removed. A geometric tolerance must not swallow a short feature.
      if (previous === undefined || previous[0] !== x || previous[1] !== y || previous[2] !== z) points.push([x, y, z]);
    }
    if (points.length >= 2) components.push(points);
  }
  return components;
}

/** Degree-one B-splines preserve the certified chords in O(n), without an O(n³) global interpolator. */
export function makeFunctionCurve(oc: OpenCascadeInstance, spec: FunctionCurveGeometrySpec,
  isCancelled: () => boolean = () => false): FunctionCurveGeometryResult {
  if (isCancelled()) return { status: 'cancelled' };
  const components = checkedComponents(spec), bezier = checkedBezier(spec);
  if (components.length === 0 && bezier === undefined) return { status: 'empty' };
  const { keep, release } = createAllocations();
  try {
    const edges: TopoDS_Shape[] = [];
    if (bezier !== undefined) edges.push(keep(makeSplineEdge(oc, { mode: 'control', points: bezier, closed: false })).edge);
    for (const points of components) {
      if (isCancelled()) { release(); return { status: 'cancelled' }; }
      const poles = keep(new oc.TColgp_Array1OfPnt_2(1, points.length));
      const knots = keep(new oc.TColStd_Array1OfReal_2(1, points.length));
      const multiplicities = keep(new oc.TColStd_Array1OfInteger_2(1, points.length));
      for (let index = 0; index < points.length; index++) {
        if (index % 128 === 0 && isCancelled()) { release(); return { status: 'cancelled' }; }
        const point = new oc.gp_Pnt_3(...points[index]);
        try { poles.SetValue(index + 1, point); } finally { point.delete(); }
        knots.SetValue(index + 1, index);
        multiplicities.SetValue(index + 1, index === 0 || index === points.length - 1 ? 2 : 1);
      }
      const curve = keep(new oc.Geom_BSplineCurve_1(poles, knots, multiplicities, 1, false));
      const handle = keep(new oc.Handle_Geom_Curve_2(curve));
      const maker = keep(new oc.BRepBuilderAPI_MakeEdge_24(handle));
      if (!maker.IsDone()) throw new Error('関数の曲線をCADの辺へ変換できませんでした。');
      edges.push(keep(maker.Edge()));
    }
    const source = keep(makeCompound(oc, edges));
    const result = clipFunctionShape(oc, source.shape, spec.bounds, 'edge');
    if (result.status === 'shape') keep(result);
    if (isCancelled()) {
      release();
      return { status: 'cancelled' };
    }
    if (result.status === 'empty') { release(); return result; }
    // The trimmed edge can share a Geom_Curve with its source. Retain the makers and
    // raw curve wrappers until the result is released, then dispose in reverse order.
    return { status: 'shape', shape: result.shape, count: result.count, delete: release };
  } catch (error) { release(); throw error; }
}
