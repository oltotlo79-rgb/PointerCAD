/**
 * Native C1 bicubic B-spline face for a certified function surface, then the same six-plane face clip as exact
 * analytic surfaces. The math Worker supplies distinct knots per direction and (2*nu) x (2*nv) poles (row-major in u);
 * multiplicities are implied (4 at the ends, 2 inside), so OCCT holds exactly the certified C1 patches.
 */
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import type { Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { borrowHandle } from './borrowHandle.js';
import { clipFunctionShape, type FunctionClipBox } from './clipFunctionShape.js';
import type { FunctionSurfaceGeometryResult } from './makeFunctionSurface.js';

export interface FunctionSurfaceSplineSpec {
  readonly uKnots: readonly number[];
  readonly vKnots: readonly number[];
  readonly poles: readonly Vec3Tuple[];
  readonly errorBound: number;
}
/** Same shared ceiling as the math Worker's spline route. */
export const MAX_FUNCTION_SURFACE_SPLINE_POLES = 200_000;
/** OCCT rejects knots closer than its relative knot epsilon; require a clear margin. */
const KNOT_GAP = 64 * Number.EPSILON;

function array(value: unknown): value is readonly unknown[] { return Array.isArray(value); }
function knots(value: unknown, label: string): number[] {
  if (!array(value) || value.length < 2) throw new Error(`関数曲面の${label}方向の節点を確認してください。`);
  const result: number[] = [];
  for (const knot of value) {
    if (typeof knot !== 'number' || !Number.isFinite(knot)) throw new Error(`関数曲面の${label}方向の節点は有限の実数にしてください。`);
    const previous = result.at(-1);
    if (previous !== undefined && !(knot - previous > KNOT_GAP * Math.max(1, Math.abs(knot), Math.abs(previous)))) {
      throw new Error(`関数曲面の${label}方向の節点が近すぎるか増加していません。`);
    }
    result.push(knot);
  }
  return result;
}

/** Structure only, before any WASM allocation; the certificate itself was checked by the math reply decoder. */
export function checkedFunctionSurfaceSpline(value: unknown): FunctionSurfaceSplineSpec {
  if (value === null || typeof value !== 'object' || array(value)) throw new Error('関数曲面の滑らかな面の指定が不正です。');
  const keys = Object.keys(value);
  if (keys.length !== 4 || !['uKnots', 'vKnots', 'poles', 'errorBound'].every(key => keys.includes(key))) {
    throw new Error('関数曲面の滑らかな面の項目を確認してください。');
  }
  const u = knots(Reflect.get(value, 'uKnots'), 'U'), v = knots(Reflect.get(value, 'vKnots'), 'V');
  const count = 4 * u.length * v.length, raw: unknown = Reflect.get(value, 'poles'), errorBound: unknown = Reflect.get(value, 'errorBound');
  if (count > MAX_FUNCTION_SURFACE_SPLINE_POLES || !array(raw) || raw.length !== count) {
    throw new Error('関数曲面の滑らかな面の制御点数が節点と一致しないか上限を超えています。');
  }
  if (typeof errorBound !== 'number' || !Number.isFinite(errorBound) || errorBound < 0) throw new Error('関数曲面の滑らかな面の精度を確認してください。');
  const poles: Vec3Tuple[] = [];
  for (const pole of raw) {
    if (!array(pole) || pole.length !== 3 || !pole.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))) {
      throw new Error('関数曲面の滑らかな面の制御点は有限のXYZにしてください。');
    }
    const [x, y, z] = pole;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') throw new Error('関数曲面の滑らかな面の制御点は有限のXYZにしてください。');
    poles.push([x, y, z]);
  }
  return { uKnots: u, vKnots: v, poles, errorBound };
}

/** Build the native surface and face, verify its actual degree/continuity, then clip it to the XYZ box. */
export function makeFunctionSurfaceSpline(oc: OpenCascadeInstance, value: unknown, bounds: FunctionClipBox,
  isCancelled: () => boolean): FunctionSurfaceGeometryResult {
  const spec = checkedFunctionSurfaceSpline(value);
  if (isCancelled()) return { status: 'cancelled' };
  const owner = createAllocations(), { keep } = owner;
  try {
    const rows = 2 * spec.uKnots.length, columns = 2 * spec.vKnots.length;
    const poles = keep(new oc.TColgp_Array2OfPnt_2(1, rows, 1, columns));
    for (let p = 0; p < rows; p++) {
      if (p % 32 === 0 && isCancelled()) { owner.release(); return { status: 'cancelled' }; }
      for (let q = 0; q < columns; q++) {
        const point = new oc.gp_Pnt_3(...spec.poles[p * columns + q]);
        try { poles.SetValue(p + 1, q + 1, point); } finally { point.delete(); }
      }
    }
    const knotArray = (values: readonly number[]) => {
      const result = keep(new oc.TColStd_Array1OfReal_2(1, values.length));
      values.forEach((knot, index) => result.SetValue(index + 1, knot));
      return result;
    };
    const multiplicities = (count: number) => {
      const result = keep(new oc.TColStd_Array1OfInteger_2(1, count));
      for (let index = 0; index < count; index++) result.SetValue(index + 1, index === 0 || index === count - 1 ? 4 : 2);
      return result;
    };
    const surface = keep(new oc.Geom_BSplineSurface_1(poles, knotArray(spec.uKnots), knotArray(spec.vKnots),
      multiplicities(spec.uKnots.length), multiplicities(spec.vKnots.length), 3, 3, false, false));
    // Native confirmation of what was promised: bicubic, non-rational, C1 and (generically) not C2 at the knots.
    if (Number(surface.UDegree()) !== 3 || Number(surface.VDegree()) !== 3 || surface.IsURational() || surface.IsVRational()
      || !surface.IsCNu(1) || !surface.IsCNv(1)) throw new Error('関数曲面の滑らかな面をC1の3次面として作れませんでした。');
    const handle = keep(new oc.Handle_Geom_Surface_2(surface));
    const maker = keep(new oc.BRepBuilderAPI_MakeFace_8(handle, 1e-7));
    if (!maker.IsDone()) throw new Error('関数曲面の滑らかな面を作れませんでした。');
    const face = keep(maker.Face());
    if (isCancelled()) { owner.release(); return { status: 'cancelled' }; }
    const clipped = clipFunctionShape(oc, face, bounds, 'face');
    if (clipped.status === 'shape') keep(clipped);
    if (isCancelled()) { owner.release(); return { status: 'cancelled' }; }
    if (clipped.status !== 'shape') { owner.release(); return clipped; }
    return { status: 'shape', shape: clipped.shape, count: clipped.count, delete: () => owner.release() };
  } catch (error) { owner.release(); throw error; }
}

/** Read the native B-spline surface of a face (for tests and audits): degree, knots, multiplicities and C1. */
export function readFunctionSurfaceSpline(oc: OpenCascadeInstance, face: TopoDS_Shape) {
  const owner = createAllocations();
  try {
    const adaptor = owner.keep(new oc.BRepAdaptor_Surface_2(owner.keep(oc.TopoDS.Face_1(face)), true));
    if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_BSplineSurface) return null;
    const surface = borrowHandle(owner.keep(adaptor.BSpline()));
    const read = (count: number, knot: (index: number) => number, multiplicity: (index: number) => number) =>
      Array.from({ length: count }, (_, index) => ({ knot: knot(index + 1), multiplicity: multiplicity(index + 1) }));
    return {
      uDegree: Number(surface.UDegree()), vDegree: Number(surface.VDegree()),
      rational: surface.IsURational() || surface.IsVRational(),
      c1: surface.IsCNu(1) && surface.IsCNv(1), c2: surface.IsCNu(2) && surface.IsCNv(2),
      u: read(Number(surface.NbUKnots()), index => surface.UKnot(index), index => Number(surface.UMultiplicity(index))),
      v: read(Number(surface.NbVKnots()), index => surface.VKnot(index), index => Number(surface.VMultiplicity(index))),
    };
  } finally { owner.release(); }
}
