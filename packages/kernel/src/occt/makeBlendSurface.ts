import type { Handle_Geom_Surface, OpenCascadeInstance, TopoDS_Face } from 'opencascade.js/dist/opencascade.full.js';
import { createAllocations, type Allocations } from './allocations.js';
import { BlendSurfaceError, readBlendBoundary, type BlendEdgeSource } from './blendBoundary.js';
import { blendControlRows, measureBlend, type BlendSurfaceInput, type BlendTolerance } from './blendControlRows.js';
import { separatedKnots } from './functionCurveSpline.js';
import { MAX_FUNCTION_SURFACE_SPLINE_POLES } from './functionSurfaceSpline.js';
import { isValidShape } from './solidMesh.js';
import { APPROXIMATION_TOLERANCE_MM, GEOMETRIC_CONFUSION_MM } from './tolerances.js';

function splineAxis(oc: OpenCascadeInstance, owner: Allocations, values: readonly number[]) {
  const knots = owner.keep(new oc.TColStd_Array1OfReal_2(1, values.length));
  const mults = owner.keep(new oc.TColStd_Array1OfInteger_2(1, values.length));
  values.forEach((value, i) => {
    knots.SetValue(i + 1, value);
    mults.SetValue(i + 1, i === 0 || i === values.length - 1 ? 4 : 2);
  });
  return { knots, mults };
}

function makeFace(oc: OpenCascadeInstance, input: BlendSurfaceInput, owner: Allocations): TopoDS_Face {
  const rows = blendControlRows(input);
  const work = createAllocations();
  try {
    const poles = work.keep(new oc.TColgp_Array2OfPnt_2(1, rows[0].length, 1, rows.length));
    rows.forEach((row, v) => row.forEach((coordinates, u) => {
      const point = new oc.gp_Pnt_3(...coordinates);
      try { poles.SetValue(u + 1, v + 1, point); } finally { point.delete(); }
    }));
    const u = splineAxis(oc, work, input.uKnots), v = splineAxis(oc, work, [0, 1]);
    const raw = new oc.Geom_BSplineSurface_1(poles, u.knots, v.knots, u.mults, v.mults, 3, 3, false, false);
    // The Handle takes ownership of the Geom pointee once its constructor succeeds.
    let handle: Handle_Geom_Surface;
    try { handle = new oc.Handle_Geom_Surface_2(raw); }
    catch (error) { raw.delete(); throw error; }
    owner.keep(handle);
    const maker = owner.keep(new oc.BRepBuilderAPI_MakeFace_8(handle, GEOMETRIC_CONFUSION_MM));
    if (!maker.IsDone()) throw new BlendSurfaceError('blend-failed');
    return owner.keep(maker.Face());
  } finally { work.release(); }
}

function measureFace(oc: OpenCascadeInstance, face: TopoDS_Face, input: BlendSurfaceInput, tolerance: BlendTolerance) {
  const work = createAllocations();
  try {
    const adaptor = work.keep(new oc.BRepAdaptor_Surface_2(face, true));
    const point = work.keep(new oc.gp_Pnt_1());
    const du = work.keep(new oc.gp_Vec_1()), dv = work.keep(new oc.gp_Vec_1());
    return measureBlend(input, tolerance, (u, v) => {
      adaptor.D1(u, v, point, du, dv);
      return { point: [point.X(), point.Y(), point.Z()], tangent: [dv.X(), dv.Y(), dv.Z()],
        alongU: [du.X(), du.Y(), du.Z()] };
    });
  } finally { work.release(); }
}

type Measurement = ReturnType<typeof measureBlend>;
type BlendResult =
  | { readonly status: 'shape'; readonly shape: TopoDS_Face; readonly measurement: Measurement; delete(): void }
  | { readonly status: 'outside-tolerance'; readonly measurement: Measurement; readonly exceeded: readonly ('distance' | 'angle')[] };

/** 許容差を超えた量の種類(文は画面の側が持つ)。 */
function exceededTolerances(measurement: Measurement, tolerance: BlendTolerance): readonly ('distance' | 'angle')[] {
  const exceeded: ('distance' | 'angle')[] = [];
  if (measurement.maxDistanceMm > tolerance.distanceMm) exceeded.push('distance');
  if (measurement.maxAngleDeg > tolerance.angleDeg) exceeded.push('angle');
  return exceeded;
}

/** The successful caller owns one face. A sampled failure returns its measured discrepancies. */
function fitMeasuredFace(oc: OpenCascadeInstance, input: BlendSurfaceInput, tolerance: BlendTolerance,
  measureKnots: readonly number[] = input.uKnots): BlendResult {
  // Four rows of 2*n poles. Check before evaluating any source geometry or allocating native arrays.
  if (8 * input.uKnots.length > MAX_FUNCTION_SURFACE_SPLINE_POLES || !separatedKnots(input.uKnots)) {
    throw new RangeError('blend U basis');
  }
  const owner = createAllocations();
  try {
    const face = makeFace(oc, input, owner);
    const measurement = measureFace(oc, face, { ...input, uKnots: measureKnots }, tolerance);
    if (!measurement.withinTolerance) {
      owner.release();
      return { status: 'outside-tolerance', measurement, exceeded: exceededTolerances(measurement, tolerance) };
    }
    if (!isValidShape(oc, face)) throw new BlendSurfaceError('invalid-blend-face');
    return { status: 'shape', shape: face, measurement, delete: owner.release };
  } catch (error) { owner.release(); throw error; }
}

interface BoundaryBlendInput {
  readonly a: BlendEdgeSource;
  readonly b: BlendEdgeSource;
  readonly weightA: number;
  readonly weightB: number;
  readonly flipB: boolean;
}

/** Keep source spline breaks, clustering extra samples near each span end where the
 * one-sided secant needs the shortest step. Keep the shared pole limit on every fit. */
function refinedKnots(breaks: readonly number[], divisions: number): number[] {
  const knots = [breaks[0]];
  for (let span = 1; span < breaks.length; span++) {
    const left = breaks[span - 1], right = breaks[span];
    for (let i = 1; i < divisions; i++) {
      const fraction = Math.sin(Math.PI * i / (2 * divisions)) ** 2;
      knots.push(left + (right - left) * fraction);
    }
    knots.push(right);
  }
  return knots;
}

// Merge equivalent breaks in the common, normalized U domain. Always preserve the two exact end parameters.
// U has no unit: a gap is compared as a length along the longer edge (U gap x edge length in mm), so the same
// geometric tolerance merges only breaks that no edge can tell apart.
function commonBreaks(ordered: readonly number[], lengthMm: number): number[] {
  const kept = [0];
  for (const u of ordered) {
    if ((u - kept[kept.length - 1]) * lengthMm > GEOMETRIC_CONFUSION_MM && (1 - u) * lengthMm > GEOMETRIC_CONFUSION_MM) kept.push(u);
  }
  kept.push(1);
  return kept;
}

/** Release the borrowed boundary adaptors. If that fails, a face already made is released too and the error propagates. */
function releaseBoundaries(source: Allocations, result: BlendResult | undefined): void {
  try { source.release(); } catch (error) {
    if (result?.status === 'shape') result.delete();
    throw error;
  }
}

const DEFAULT_BLEND_TOLERANCE: BlendTolerance = { distanceMm: APPROXIMATION_TOLERANCE_MM, angleDeg: 0.01 };

/** Native edges use a shared normalized U and unit transverse tangents (weights in mm).
 * A sampled rejection owns nothing. Only the returned successful face needs delete(). */
function* fitAttempts(oc: OpenCascadeInstance, input: BoundaryBlendInput | BlendSurfaceInput,
  tolerance: BlendTolerance): Generator<void, BlendResult> {
  if ('uKnots' in input) {
    yield;
    return fitMeasuredFace(oc, input, tolerance);
  }
  if (![input.weightA, input.weightB].every(weight => Number.isFinite(weight) && weight > 0)) {
    throw new RangeError('つなぎの重みは正の有限な長さで指定してください。');
  }
  const source = createAllocations();
  let result: BlendResult | undefined;
  try {
    const a = readBlendBoundary(oc, input.a, 'a', source), b = readBlendBoundary(oc, input.b, 'b', source);
    if (a.edge.IsSame(b.edge)) throw new Error('つなぎに使う異なる 2 本の辺を選んでください。');
    const sourceKnots = [...new Set([0, ...a.knots, ...b.knots.map(u => input.flipB ? 1 - u : u), 1])].sort((x, y) => x - y);
    const breaks = commonBreaks(sourceKnots, Math.max(input.a.query.length, input.b.query.length));
    const fit = { edgeA: a.evaluate, edgeB: b.evaluate, weightA: input.weightA, weightB: input.weightB, flipB: input.flipB };
    for (const divisions of [1, 4, 16, 64, 256, 512]) {
      if (8 * (1 + (breaks.length - 1) * divisions) > MAX_FUNCTION_SURFACE_SPLINE_POLES) break;
      yield;
      const uKnots = refinedKnots(breaks, divisions);
      if (!separatedKnots(uKnots)) break;
      // Only the native spline basis needs separated knots. Still measure both original source breaks.
      const measureKnots = breaks.length === sourceKnots.length ? uKnots
        : [...new Set([...uKnots, ...sourceKnots])].sort((left, right) => left - right);
      result = fitMeasuredFace(oc, { ...fit, uKnots }, tolerance, measureKnots);
      if (result.status === 'shape') return result;
    }
    if (result) return result;
    throw new Error('両辺の節が多すぎるか、近すぎるため、許容差を確認できません。');
  } finally {
    releaseBoundaries(source, result);
  }
}

interface CancelledFit { readonly status: 'cancelled' }
type CancelProbe = () => boolean | Promise<boolean>;

async function checkedFits(attempts: Generator<void, BlendResult | CancelledFit>, shouldCancel: CancelProbe):
Promise<BlendResult | CancelledFit> {
  let step = attempts.next();
  try {
    while (!step.done) {
      if (await shouldCancel()) return { status: 'cancelled' };
      step = attempts.next();
    }
    return step.value;
  } finally {
    // Closing a suspended generator releases both borrowed boundary adaptors, even if the probe rejects.
    if (!step.done) attempts.return({ status: 'cancelled' });
  }
}

export function makeBlendSurface(oc: OpenCascadeInstance, input: BoundaryBlendInput | BlendSurfaceInput,
  tolerance?: BlendTolerance): BlendResult;
export function makeBlendSurface(oc: OpenCascadeInstance, input: BoundaryBlendInput | BlendSurfaceInput,
  tolerance: BlendTolerance | undefined, shouldCancel: CancelProbe): Promise<BlendResult | CancelledFit>;
export function makeBlendSurface(oc: OpenCascadeInstance, input: BoundaryBlendInput | BlendSurfaceInput,
  tolerance: BlendTolerance = DEFAULT_BLEND_TOLERANCE, shouldCancel?: CancelProbe): BlendResult | Promise<BlendResult | CancelledFit> {
  const attempts = fitAttempts(oc, input, tolerance);
  if (shouldCancel !== undefined) return checkedFits(attempts, shouldCancel);
  let step = attempts.next();
  while (!step.done) step = attempts.next();
  return step.value;
}
