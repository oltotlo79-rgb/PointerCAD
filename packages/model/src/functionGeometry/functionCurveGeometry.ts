/** Plain model data crossing the geometry Worker. No OCCT handles or UI-only clipping. */
import type { ResolvedSpline } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';

/** Certified C1 cubic of one component: distinct parameter knots and 2 * knots poles (double interior knots). */
export interface FunctionCurveSplineInput {
  readonly knots: readonly number[];
  readonly poles: readonly Vec3[];
}
export interface FunctionCurveGeometryInput {
  readonly featureId: string;
  readonly components: readonly (readonly Vec3[])[];
  readonly bezier?: readonly [Vec3, Vec3, Vec3, Vec3];
  /** One per component when the math Worker proved a smooth curve within the tolerance. */
  readonly splines?: readonly FunctionCurveSplineInput[];
  readonly bounds: { readonly minimum: Vec3; readonly maximum: Vec3 };
}
export type FunctionCurveGeometryOutcome =
  | { readonly status: 'ready'; readonly curves: readonly ResolvedSpline[] }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly message: string };
export interface FunctionKernelBridge {
  functionSketchCurves(input: FunctionCurveGeometryInput): Promise<FunctionCurveGeometryOutcome>;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function array(value: unknown): value is readonly unknown[] { return Array.isArray(value); }
const invalid = (): FunctionCurveGeometryOutcome => ({ status: 'failed', message: '関数曲線の計算結果を確認できませんでした。' });
const CURVE_FIELDS = ['kind', 'mode', 'degree', 'closed', 'points'];
const SMOOTH_FIELDS = ['kind', 'mode', 'degree', 'closed', 'knots', 'points'];

function point(value: unknown): Vec3 | null {
  if (!array(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number' || ![x, y, z].every(Number.isFinite)) return null;
  return Object.freeze([x, y, z]);
}
function inside(xyz: Vec3, input: FunctionCurveGeometryInput): boolean {
  return xyz.every((coordinate, axis) => coordinate >= input.bounds.minimum[axis] - 1e-6 && coordinate <= input.bounds.maximum[axis] + 1e-6);
}

/**
 * A clipped smooth piece: knots inside the requested parameter range and strictly increasing, the C1 pole
 * layout, and every on-curve point (ends and implied junctions) inside the clip box. Inner poles are control
 * points, not curve points, so they are only required to be finite.
 */
function smoothCurve(item: Record<string, unknown>, input: FunctionCurveGeometryInput, lower: number, upper: number): ResolvedSpline | null {
  if (item.kind !== 'spline' || item.mode !== 'control' || item.degree !== 3 || item.closed !== false
    || !array(item.knots) || !array(item.points) || Object.keys(item).length !== SMOOTH_FIELDS.length
    || Object.keys(item).some(key => !SMOOTH_FIELDS.includes(key))) return null;
  const knots: number[] = [];
  for (const knot of item.knots) {
    if (typeof knot !== 'number' || !Number.isFinite(knot) || knot < lower || knot > upper || knots.length > 0 && !(knot > knots[knots.length - 1])) return null;
    knots.push(knot);
  }
  if (knots.length < 2 || item.points.length !== 2 * knots.length) return null;
  const points: Vec3[] = [];
  for (const value of item.points) {
    const xyz = point(value);
    if (xyz === null) return null;
    points.push(xyz);
  }
  const last = knots.length - 1;
  for (let index = 0; index <= last; index++) {
    let onCurve = points[index === 0 ? 0 : points.length - 1];
    if (index > 0 && index < last) {
      const left = knots[index] - knots[index - 1], right = knots[index + 1] - knots[index], share = left / (left + right);
      const a = points[2 * index], b = points[2 * index + 1];
      onCurve = [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share, a[2] + (b[2] - a[2]) * share];
    }
    if (!inside(onCurve, input)) return null;
  }
  return Object.freeze({ kind: 'spline', featureId: input.featureId, mode: 'control', degree: 3 as const, closed: false,
    knots: Object.freeze(knots), points: Object.freeze(points) });
}

/** Validate the CAD reply as well as the math reply; reject incomplete/out-of-range output atomically. */
export function readFunctionCurveGeometry(value: unknown, input: FunctionCurveGeometryInput): FunctionCurveGeometryOutcome {
  if (!record(value)) return invalid();
  if (value.status === 'cancelled' && Object.keys(value).length === 1) return { status: 'cancelled' };
  if (value.status === 'failed' && typeof value.message === 'string' && value.message.length > 0
    && Object.keys(value).length === 2) return { status: 'failed', message: value.message };
  if (value.status !== 'ready' || !array(value.curves) || value.curves.length > 200_000 || Object.keys(value).length !== 2) return invalid();
  if (input.bezier !== undefined && value.curves.length !== 1) return invalid();
  const knots = input.splines?.flatMap(spline => [spline.knots[0], spline.knots[spline.knots.length - 1]]) ?? [];
  const lower = Math.min(...knots), upper = Math.max(...knots);
  const curves: ResolvedSpline[] = [];
  let total = 0;
  for (const item of value.curves) {
    if (input.splines !== undefined && record(item) && item.degree === 3) {
      // Smooth pieces are accepted only when the request carried proved smooth components.
      const curve = smoothCurve(item, input, lower, upper);
      if (curve === null || (total += curve.points.length) > 200_000) return invalid();
      curves.push(curve);
      continue;
    }
    const cubic = input.bezier !== undefined;
    const fields = cubic ? CURVE_FIELDS.filter(key => key !== 'degree') : CURVE_FIELDS;
    if (!record(item) || item.kind !== 'spline' || item.mode !== 'control' || (cubic ? 'degree' in item : item.degree !== 1)
      || typeof item.closed !== 'boolean' || !array(item.points) || Object.keys(item).length !== fields.length
      || Object.keys(item).some(key => !fields.includes(key))
      || cubic && (value.curves.length !== 1 || item.points.length !== 4 || item.closed || input.components.length !== 0)
      || item.points.length < (item.closed ? 3 : 2) || (total += item.points.length) > 200_000) return invalid();
    const points: Vec3[] = [];
    for (const entry of item.points) {
      const xyz = point(entry);
      if (xyz === null || !inside(xyz, input)) return invalid();
      points.push(xyz);
    }
    // Only the exact, enclosed cubic that was requested may replace the linear response.
    if (input.bezier !== undefined && points.some((entry, index) => entry.some((coordinate, axis) => coordinate !== input.bezier?.[index][axis]))) return invalid();
    curves.push(Object.freeze({ kind: 'spline', featureId: input.featureId, mode: 'control', ...(cubic ? {} : { degree: 1 as const }),
      closed: item.closed, points: Object.freeze(points) }));
  }
  return { status: 'ready', curves: Object.freeze(curves) };
}
