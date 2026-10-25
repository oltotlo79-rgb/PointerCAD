/**
 * Native C1 cubic B-splines for certified smooth function curves.
 *
 * The expression Worker sends, per component, its distinct sample parameters as knots and 2 * knots poles: the
 * curve start, then each span's two inner Bezier poles, then the curve end. Interior knots have multiplicity 2,
 * so OCCT holds the exact C1 piecewise cubic (no fitting or resampling here). After exact clipping, the surviving
 * parameter range is read back from the native curve by de Casteljau subdivision of the end spans only.
 */
import type { BRepAdaptor_Curve, OpenCascadeInstance, TopoDS_Edge } from 'opencascade.js/dist/opencascade.full.js';
import type { Vec3Tuple } from '../types.js';
import { borrowHandle } from './borrowHandle.js';

export interface FunctionCurveSplineSpec {
  /** Strictly increasing function parameters; the curve is parameterized by them. */
  readonly knots: readonly number[];
  /** 2 * knots.length poles of the C1 cubic with double interior knots. */
  readonly poles: readonly Vec3Tuple[];
}
/** Sketch-ready smooth piece: same pole layout over the clipped parameter range. */
export interface FunctionCurveSplineCurve {
  readonly kind: 'spline';
  readonly mode: 'control';
  readonly degree: 3;
  readonly closed: false;
  readonly knots: readonly number[];
  readonly points: readonly Vec3Tuple[];
}
/** OCCT rejects knots closer than its own epsilon; keep a margin well above one ulp. */
const KNOT_GAP = 64 * Number.EPSILON;

type Keep = <T extends { delete(): void }>(value: T) => T;
function array(value: unknown): value is readonly unknown[] { return Array.isArray(value); }
function finitePoint(value: unknown): value is Vec3Tuple {
  return array(value) && value.length === 3 && value.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate));
}
/** Native construction is possible only when every knot gap clearly exceeds OCCT's relative knot epsilon. */
export function separatedKnots(knots: readonly number[]): boolean {
  for (let index = 1; index < knots.length; index++) {
    const gap = knots[index] - knots[index - 1];
    if (!(gap > KNOT_GAP * Math.max(1, Math.abs(knots[index]), Math.abs(knots[index - 1])))) return false;
  }
  return true;
}

/** Validate one spline against its component before any WASM allocation. */
export function checkedFunctionCurveSpline(value: unknown, component: readonly unknown[]): FunctionCurveSplineSpec {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('関数曲線の滑らかな成分の指定が不正です。');
  const knots: unknown = Reflect.get(value, 'knots'), poles: unknown = Reflect.get(value, 'poles');
  if (Object.keys(value).length !== 2 || !array(knots) || !array(poles) || knots.length !== component.length || knots.length < 2
    || poles.length !== 2 * knots.length) throw new Error('関数曲線の滑らかな成分の点数が標本と一致しません。');
  const checkedKnots: number[] = [];
  for (const knot of knots) {
    if (typeof knot !== 'number' || !Number.isFinite(knot) || (checkedKnots.length > 0 && !(knot > checkedKnots[checkedKnots.length - 1]))) {
      throw new Error('関数曲線の節点は増加する有限の実数にしてください。');
    }
    checkedKnots.push(knot);
  }
  const checkedPoles: Vec3Tuple[] = [];
  for (const pole of poles) {
    if (!finitePoint(pole)) throw new Error('関数曲線の制御点は有限のXYZにしてください。');
    checkedPoles.push([pole[0], pole[1], pole[2]]);
  }
  const first = component[0], last = component[component.length - 1];
  const same = (point: Vec3Tuple, sample: unknown) => finitePoint(sample) && point.every((coordinate, axis) => coordinate === sample[axis]);
  if (!same(checkedPoles[0], first) || !same(checkedPoles[checkedPoles.length - 1], last)) {
    throw new Error('関数曲線の滑らかな成分の端点が標本と一致しません。');
  }
  // OCCT places the curve point at interior knot i between poles 2i and 2i+1 (share h_{i-1}/(h_{i-1}+h_i)). It must be
  // the certified sample up to the rounding of building and rebuilding it (same rule as the Worker reply decoder), so
  // inner poles of a different chain are refused before allocation.
  for (let node = 1; node < checkedKnots.length - 1; node++) {
    const sample: unknown = component[node];
    if (!finitePoint(sample)) throw new Error('関数曲線の各点にXYZを指定してください。');
    const left = checkedKnots[node] - checkedKnots[node - 1], right = checkedKnots[node + 1] - checkedKnots[node];
    const share = left / (left + right), a = checkedPoles[2 * node], b = checkedPoles[2 * node + 1];
    for (let axis = 0; axis < 3; axis++) {
      const junction = a[axis] + (b[axis] - a[axis]) * share;
      const allowed = 16 * Number.EPSILON * (Math.abs(a[axis]) + Math.abs(b[axis]) + Math.abs(sample[axis]));
      if (!(Math.abs(junction - sample[axis]) <= allowed)) throw new Error('関数曲線の滑らかな制御点が標本の位置を通りません。');
    }
  }
  return { knots: checkedKnots, poles: checkedPoles };
}

/** One native Geom_BSplineCurve (degree 3, multiplicities 4,2,...,2,4). All wrappers are kept by the caller. */
export function makeFunctionCurveSplineEdge(oc: OpenCascadeInstance, spline: FunctionCurveSplineSpec, keep: Keep,
  isCancelled: () => boolean): TopoDS_Edge | null {
  const count = spline.knots.length;
  const poles = keep(new oc.TColgp_Array1OfPnt_2(1, 2 * count));
  for (let index = 0; index < 2 * count; index++) {
    if (index % 128 === 0 && isCancelled()) return null;
    const point = new oc.gp_Pnt_3(...spline.poles[index]);
    try { poles.SetValue(index + 1, point); } finally { point.delete(); }
  }
  const knots = keep(new oc.TColStd_Array1OfReal_2(1, count));
  const multiplicities = keep(new oc.TColStd_Array1OfInteger_2(1, count));
  for (let index = 0; index < count; index++) {
    knots.SetValue(index + 1, spline.knots[index]);
    multiplicities.SetValue(index + 1, index === 0 || index === count - 1 ? 4 : 2);
  }
  const curve = keep(new oc.Geom_BSplineCurve_1(poles, knots, multiplicities, 3, false));
  const handle = keep(new oc.Handle_Geom_Curve_2(curve));
  const maker = keep(new oc.BRepBuilderAPI_MakeEdge_24(handle));
  if (!maker.IsDone()) throw new Error('関数の滑らかな曲線をCADの辺へ変換できませんでした。');
  return keep(maker.Edge());
}

type Bezier = [Vec3Tuple, Vec3Tuple, Vec3Tuple, Vec3Tuple];
const lerp = (a: Vec3Tuple, b: Vec3Tuple, u: number): Vec3Tuple => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
/** Exact-up-to-rounding de Casteljau split of a cubic at u; returns [left, right]. */
export function splitBezier(bezier: Bezier, u: number): [Bezier, Bezier] {
  const [p0, p1, p2, p3] = bezier;
  const a = lerp(p0, p1, u), b = lerp(p1, p2, u), c = lerp(p2, p3, u);
  const d = lerp(a, b, u), e = lerp(b, c, u), f = lerp(d, e, u);
  return [[p0, a, d, f], [f, e, c, p3]];
}

/**
 * Read the native smooth curve of a clipped edge over [first, last] in the same pole layout. Throws when the
 * native curve is not the expected non-rational, non-periodic C1 cubic; never approximates a changed curve.
 */
export function readFunctionCurveSplineEdge(oc: OpenCascadeInstance, adaptor: BRepAdaptor_Curve,
  first: number, last: number, reversed: boolean, keep: Keep): FunctionCurveSplineCurve {
  if (adaptor.GetType() !== oc.GeomAbs_CurveType.GeomAbs_BSplineCurve || Number(adaptor.Degree()) !== 3 || adaptor.IsRational()) {
    throw new Error('関数の滑らかな曲線の種類が変化しました。');
  }
  const spline = borrowHandle(keep(adaptor.BSpline()));
  const count = Number(spline.NbKnots());
  if (!Number.isSafeInteger(count) || count < 2 || count > 100_000 || spline.IsPeriodic() || Number(spline.NbPoles()) !== 2 * count) {
    throw new Error('関数の滑らかな曲線の節点が変化しました。');
  }
  const knots: number[] = [], poles: Vec3Tuple[] = [];
  for (let index = 1; index <= count; index++) {
    const multiplicity = Number(spline.Multiplicity(index));
    if (multiplicity !== (index === 1 || index === count ? 4 : 2)) throw new Error('関数の滑らかな曲線の連続性が変化しました。');
    knots.push(spline.Knot(index));
  }
  for (let index = 1; index <= 2 * count; index++) {
    const point = spline.Pole(index);
    try { poles.push([point.X(), point.Y(), point.Z()]); } finally { point.delete(); }
  }
  if (!(first >= knots[0] && last <= knots[count - 1] && first < last)) throw new Error('関数の滑らかな曲線の切断範囲を読み取れませんでした。');
  // Bezier form of span j: junction J_j, poles[2j+1], poles[2j+2], junction J_{j+1}.
  const junction = (index: number): Vec3Tuple => {
    if (index === 0) return poles[0];
    if (index === count - 1) return poles[2 * count - 1];
    const left = knots[index] - knots[index - 1], right = knots[index + 1] - knots[index];
    return lerp(poles[2 * index], poles[2 * index + 1], left / (left + right));
  };
  const bezier = (index: number): Bezier => [junction(index), poles[2 * index + 1], poles[2 * index + 2], junction(index + 1)];
  let start = 0;
  while (start < count - 2 && knots[start + 1] <= first) start++;
  let end = count - 2;
  while (end > start && knots[end] >= last) end--;
  const outKnots: number[] = [first], outPoles: Vec3Tuple[] = [];
  let finalPoint: Vec3Tuple | null = null;
  for (let index = start; index <= end; index++) {
    const lower = knots[index], width = knots[index + 1] - lower;
    let piece = bezier(index);
    const from = Math.max(first, lower), to = Math.min(last, knots[index + 1]);
    if (to < knots[index + 1]) piece = splitBezier(piece, (to - lower) / width)[0];
    if (from > lower) piece = splitBezier(piece, (from - lower) / (to - lower))[1];
    if (index === start) outPoles.push(piece[0]);
    outPoles.push(piece[1], piece[2]);
    outKnots.push(to);
    finalPoint = piece[3];
  }
  if (finalPoint === null) throw new Error('関数の滑らかな曲線の切断範囲を読み取れませんでした。');
  outPoles.push(finalPoint);
  if (outPoles.length !== 2 * outKnots.length || !outPoles.every(pole => pole.every(Number.isFinite))) {
    throw new Error('関数の滑らかな曲線を読み取れませんでした。');
  }
  if (reversed) {
    const total = first + last;
    return { kind: 'spline', mode: 'control', degree: 3, closed: false,
      knots: outKnots.map(knot => total - knot).reverse(), points: [...outPoles].reverse() };
  }
  return { kind: 'spline', mode: 'control', degree: 3, closed: false, knots: outKnots, points: outPoles };
}
