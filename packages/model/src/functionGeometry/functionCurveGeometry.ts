/** Plain model data crossing the geometry Worker. No OCCT handles or UI-only clipping. */
import type { ResolvedSpline } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';

export interface FunctionCurveGeometryInput {
  readonly featureId: string;
  readonly components: readonly (readonly Vec3[])[];
  readonly bezier?: readonly [Vec3, Vec3, Vec3, Vec3];
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

/** Validate the CAD reply as well as the math reply; reject incomplete/out-of-range output atomically. */
export function readFunctionCurveGeometry(value: unknown, input: FunctionCurveGeometryInput): FunctionCurveGeometryOutcome {
  if (!record(value)) return invalid();
  if (value.status === 'cancelled' && Object.keys(value).length === 1) return { status: 'cancelled' };
  if (value.status === 'failed' && typeof value.message === 'string' && value.message.length > 0
    && Object.keys(value).length === 2) return { status: 'failed', message: value.message };
  if (value.status !== 'ready' || !array(value.curves) || value.curves.length > 200_000 || Object.keys(value).length !== 2) return invalid();
  if (input.bezier !== undefined && value.curves.length !== 1) return invalid();
  const curves: ResolvedSpline[] = [];
  let total = 0;
  for (const item of value.curves) {
    const cubic = input.bezier !== undefined;
    const fields = cubic ? CURVE_FIELDS.filter(key => key !== 'degree') : CURVE_FIELDS;
    if (!record(item) || item.kind !== 'spline' || item.mode !== 'control' || (cubic ? 'degree' in item : item.degree !== 1)
      || typeof item.closed !== 'boolean' || !array(item.points) || Object.keys(item).length !== fields.length
      || Object.keys(item).some(key => !fields.includes(key))
      || cubic && (value.curves.length !== 1 || item.points.length !== 4 || item.closed || input.components.length !== 0)
      || item.points.length < (item.closed ? 3 : 2) || (total += item.points.length) > 200_000) return invalid();
    const points: Vec3[] = [];
    for (const point of item.points) {
      if (!array(point) || point.length !== 3) return invalid();
      const [x, y, z] = point;
      if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return invalid();
      const xyz: Vec3 = [x, y, z];
      if (xyz.some((coordinate, axis) => !Number.isFinite(coordinate)
        || coordinate < input.bounds.minimum[axis] - 1e-6 || coordinate > input.bounds.maximum[axis] + 1e-6)) return invalid();
      points.push(Object.freeze(xyz));
    }
    // Only the exact, enclosed cubic that was requested may replace the linear response.
    if (input.bezier !== undefined && points.some((point, index) => point.some((coordinate, axis) => coordinate !== input.bezier?.[index][axis]))) return invalid();
    curves.push(Object.freeze({ kind: 'spline', featureId: input.featureId, mode: 'control', ...(cubic ? {} : { degree: 1 as const }),
      closed: item.closed, points: Object.freeze(points) }));
  }
  return { status: 'ready', curves: Object.freeze(curves) };
}
