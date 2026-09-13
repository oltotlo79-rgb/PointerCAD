/** Read every surviving linear B-spline knot after actual XYZ clipping, without resampling. */
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import type { SplineCurveSpec, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { borrowHandle } from './borrowHandle.js';
import { makeFunctionCurve, type FunctionCurveGeometrySpec } from './makeFunctionCurve.js';

export type FunctionCurveSketchResult =
  | { readonly status: 'ready'; readonly curves: readonly SplineCurveSpec[] }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly message: string };

export function functionCurvePolylines(oc: OpenCascadeInstance, spec: FunctionCurveGeometrySpec,
  isCancelled: () => boolean = () => false): FunctionCurveSketchResult {
  const { keep, release } = createAllocations();
  try {
    const result = makeFunctionCurve(oc, spec, isCancelled);
    if (result.status === 'cancelled') return result;
    if (result.status === 'empty') return { status: 'ready', curves: [] };
    keep(result);
    const map = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(result.shape, map, true, true);
    const curves: SplineCurveSpec[] = [];
    let total = 0;
    for (let index = 1; index <= map.Size(); index++) {
      if (isCancelled()) return { status: 'cancelled' };
      const item = keep(map.FindKey(index));
      if (item.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
      const edge = keep(oc.TopoDS.Edge_1(item)), adaptor = keep(new oc.BRepAdaptor_Curve_2(edge));
      const first = adaptor.FirstParameter(), last = adaptor.LastParameter();
      if (!Number.isFinite(first) || !Number.isFinite(last) || !(first < last)) throw new Error('関数曲線の切断範囲を読み取れませんでした。');
      if (spec.bezier !== undefined) {
        // This route was proven wholly enclosed before allocation. Read the actual native poles
        // and require an unchanged single span; never approximate an unexpected trimmed curve.
        if (adaptor.GetType() !== oc.GeomAbs_CurveType.GeomAbs_BSplineCurve || Number(adaptor.Degree()) !== 3 || adaptor.IsRational()) {
          throw new Error('関数の多項式曲線の種類が変化しました。');
        }
        const spline = borrowHandle(keep(adaptor.BSpline()));
        if (Number(spline.NbPoles()) !== 4 || Number(spline.NbKnots()) !== 2
          || spline.Knot(1) !== first || spline.Knot(2) !== last || spline.IsPeriodic()) throw new Error('関数の多項式曲線の範囲が変化しました。');
        const points: Vec3Tuple[] = [];
        for (let pole = 1; pole <= 4; pole++) {
          const point = spline.Pole(pole);
          try { points.push([point.X(), point.Y(), point.Z()]); } finally { point.delete(); }
        }
        if (edge.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) points.reverse();
        curves.push({ kind: 'spline', mode: 'control', closed: false, points });
        continue;
      }
      const parameters = [first];
      if (adaptor.GetType() === oc.GeomAbs_CurveType.GeomAbs_BSplineCurve) {
        if (Number(adaptor.Degree()) !== 1 || adaptor.IsRational()) throw new Error('関数曲線の折れ線が変化しました。');
        const handle = keep(adaptor.BSpline()), spline = borrowHandle(handle);
        const count = Number(spline.NbKnots());
        if (!Number.isSafeInteger(count) || count > 200_000) throw new Error('関数曲線の節点数が上限を超えています。');
        for (let knot = 1; knot <= count; knot++) {
          const value = spline.Knot(knot);
          if (value > first && value < last) parameters.push(value);
        }
      } else if (adaptor.GetType() !== oc.GeomAbs_CurveType.GeomAbs_Line) throw new Error('関数曲線の種類が変化しました。');
      parameters.push(last);
      if ((total += parameters.length) > 200_000) throw new Error('切断後の関数曲線の点数が上限を超えています。範囲または精度を見直してください。');
      const points: Vec3Tuple[] = [];
      for (let n = 0; n < parameters.length; n++) {
        if (n % 128 === 0 && isCancelled()) return { status: 'cancelled' };
        const point = adaptor.Value(parameters[n]);
        try {
          const xyz: Vec3Tuple = [point.X(), point.Y(), point.Z()];
          if (!xyz.every(Number.isFinite)) throw new Error('関数曲線の座標を読み取れませんでした。');
          const previous = points.at(-1);
          if (previous === undefined || xyz.some((value, axis) => value !== previous[axis])) points.push(xyz);
        } finally { point.delete(); }
      }
      if (edge.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED) points.reverse();
      const end = points.at(-1);
      const closed = points.length > 3 && end !== undefined && points[0].every((value, axis) => value === end[axis]);
      if (closed) points.pop();
      if (points.length >= 2) curves.push({ kind: 'spline', mode: 'control', degree: 1, closed, points });
    }
    return isCancelled() ? { status: 'cancelled' } : { status: 'ready', curves };
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  } finally { release(); }
}
