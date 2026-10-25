/** No received surface reaches CAD until its identity, bounds, topology indices and error budget are checked. */
import { MathInputProblem } from './mathInputContract.js';
import { decodeMathRequestIdentity, type MathRequestIdentity } from './mathWorkRequest.js';
import { sameMathIdentity } from './mathWorkerClient.js';
import { functionWorkRecord, functionWorkArray, functionWorkCounter, functionWorkNumber, functionWorkPair, functionWorkPoint } from './functionWorkData.js';
import type { FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import type { FunctionSurfaceWorkReply, FunctionSurfaceWorkResult } from './functionSurfaceWorkExecution.js';
import type { FunctionSurfaceStats, FunctionSurfaceVertex } from './adaptiveFunctionSurface.js';
import { FUNCTION_SURFACE_SPLINE_POLE_LIMIT, certifySplineAgainstMeshSteps, completeSteps, type FunctionSurfaceSpline,
  type SurfaceMeshEvidence } from './smoothFunctionSurface.js';
import type { FunctionSurfaceSplineDeclined } from './functionSurfaceWorkExecution.js';

/** Received elements decoded between two resumption points. */
const STEP_ELEMENTS = 1024;
type Steps<T> = Generator<void, T, void>;

const DECLINED: readonly FunctionSurfaceSplineDeclined[] = ['topology', 'coverage', 'budget', 'samples', 'bound', 'affine'];
/**
 * Knots stay inside the variable range. They need not reach its ends: regions proved outside the XYZ box have no
 * drawn triangles, and the certificate requires every drawn triangle to lie within the spline's cells.
 */
function* knotsOf(value: unknown, lower: number, upper: number): Steps<number[]> {
  const raw = functionWorkArray(value, FUNCTION_SURFACE_SPLINE_POLE_LIMIT), knots: number[] = [];
  for (const [index, knot] of raw.entries()) {
    if (index % STEP_ELEMENTS === 0) yield;
    knots.push(functionWorkNumber(knot));
  }
  if (knots.length < 2 || knots[0] < lower || knots[knots.length - 1] > upper
    || knots.some((knot, index) => index > 0 && !(knot > knots[index - 1]))) {
    throw new MathInputProblem('domain', '曲面の滑らかな面の節点が変数の範囲外か増加していません。');
  }
  return knots;
}
/**
 * The spline covers the whole parameter rectangle with C1 knots and finite poles of the exact count, and the decoder
 * recomputes its whole certificate here from those poles and the already decoded mesh: every cell is either covered by
 * non-overlapping mesh triangle clips whose areas fill it, with its complete Bezier net bounded against their affine
 * maps, or wholly beyond one box face. Error = the reply's mesh bound + the recomputed spline-to-mesh bound, and the
 * claimed spline scalar must equal that sum exactly. The mesh bound itself is the Worker's claimed sampler bound, with
 * the same trust the triangle route gives it: this check proves spline-to-mesh consistency, not the original formula.
 * Any failure rejects the whole reply. The work is bounded by FUNCTION_SURFACE_SPLINE_PAIR_LIMIT; the steps let the
 * receiving client run it in slices.
 */
function* spline(value: unknown, request: FunctionSurfaceWorkRequest, mesh: SurfaceMeshEvidence): Steps<FunctionSurfaceSpline> {
  const raw = functionWorkRecord(value, ['uKnots', 'vKnots', 'poles', 'errorBound']);
  const uKnots = yield* knotsOf(raw.uKnots, request.lower[0], request.upper[0]), vKnots = yield* knotsOf(raw.vKnots, request.lower[1], request.upper[1]);
  const count = 4 * uKnots.length * vKnots.length;
  if (count > FUNCTION_SURFACE_SPLINE_POLE_LIMIT) throw new MathInputProblem('budget', '曲面の滑らかな面の制御点数が上限を超えています。');
  const rawPoles = functionWorkArray(raw.poles, count), poles: ReturnType<typeof functionWorkPoint>[] = [];
  for (const [index, pole] of rawPoles.entries()) {
    if (index % STEP_ELEMENTS === 0) yield;
    poles.push(functionWorkPoint(pole));
  }
  if (poles.length !== count) throw new MathInputProblem('syntax', '曲面の滑らかな面の制御点数が節点と一致しません。');
  const claimed = functionWorkNumber(raw.errorBound);
  const certificate = yield* certifySplineAgainstMeshSteps({ uKnots, vKnots, poles }, mesh, request);
  if (certificate.status !== 'certified') throw new MathInputProblem('domain', '曲面の滑らかな面が作図の面を覆うことを確認できません。');
  const errorBound = mesh.bound + certificate.splineToMesh;
  if (!(errorBound <= request.tolerance) || claimed !== errorBound) throw new MathInputProblem('domain', '曲面の滑らかな面の精度を確認できません。');
  return Object.freeze({ uKnots: Object.freeze(uKnots), vKnots: Object.freeze(vKnots), poles: Object.freeze(poles), errorBound });
}

function stats(value: unknown, request: FunctionSurfaceWorkRequest): FunctionSurfaceStats {
  const raw = functionWorkRecord(value,['samples','cells','triangles']);
  return Object.freeze({samples:functionWorkCounter(raw.samples,request.budget.maximumSamples),
    cells:functionWorkCounter(raw.cells,request.budget.maximumCells),triangles:functionWorkCounter(raw.triangles,request.budget.maximumTriangles)});
}
function* result(value: unknown, request: FunctionSurfaceWorkRequest): Steps<FunctionSurfaceWorkResult> {
  if (value === null || typeof value !== 'object' || !('status' in value)) throw new MathInputProblem('syntax','曲面の計算結果の種類を確認できません。');
  if (value.status === 'invalid') {
    const raw = functionWorkRecord(value,['status','message']);
    if (typeof raw.message !== 'string' || raw.message.length < 1 || raw.message.length > 2048) throw new MathInputProblem('syntax','曲面の失敗理由を確認できません。');
    return {status:'invalid',message:raw.message};
  }
  if (value.status === 'empty' || value.status === 'degenerate') {
    const raw = functionWorkRecord(value,['status','stats']); return {status:value.status,stats:stats(raw.stats,request)};
  }
  if (value.status === 'stopped') {
    const raw = functionWorkRecord(value,['status','reason','stats']);
    if (raw.reason !== 'cancelled' && raw.reason !== 'deadline' && raw.reason !== 'samples' && raw.reason !== 'cells'
      && raw.reason !== 'triangles' && raw.reason !== 'subdivision' && raw.reason !== 'roundoff') throw new MathInputProblem('syntax','曲面の停止理由を確認できません。');
    return {status:'stopped',reason:raw.reason,stats:stats(raw.stats,request)};
  }
  if (value.status !== 'ready') throw new MathInputProblem('syntax','曲面の計算結果の種類が不正です。');
  const raw = functionWorkRecord(value,['status','vertices','triangles','maximumInterpolationErrorBound','stats',
    ...('spline' in value ? ['spline'] : []), ...('splineDeclined' in value ? ['splineDeclined'] : [])]);
  if ('spline' in raw && 'splineDeclined' in raw) throw new MathInputProblem('syntax','曲面の滑らかな面の状態が矛盾しています。');
  const sampled = stats(raw.stats,request), error = functionWorkNumber(raw.maximumInterpolationErrorBound);
  if (error < 0 || error > request.tolerance) throw new MathInputProblem('domain','曲面の作図精度を確認できません。');
  const points = functionWorkArray(raw.vertices,sampled.samples), elements = functionWorkArray(raw.triangles,sampled.triangles);
  if (points.length < 3 || elements.length === 0 || elements.length !== sampled.triangles) throw new MathInputProblem('syntax','曲面の点数または面数が一致しません。');
  const vertices: FunctionSurfaceVertex[] = [];
  for (const [index, point] of points.entries()) {
    if (index % STEP_ELEMENTS === 0) yield;
    const entry = functionWorkRecord(point,['parameters','point']), parameters = functionWorkPair(entry.parameters);
    if (parameters.some((coordinate,axis)=>coordinate < request.lower[axis] || coordinate > request.upper[axis])) {
      throw new MathInputProblem('domain','曲面の標本が指定した変数の範囲外です。');
    }
    // World positions may lie outside the XYZ box until the following actual CAD clipping step.
    vertices.push(Object.freeze({parameters,point:functionWorkPoint(entry.point)}));
  }
  const triangles: (readonly [number,number,number])[] = [];
  for (const [index, element] of elements.entries()) {
    if (index % STEP_ELEMENTS === 0) yield;
    const indices = functionWorkArray(element,3);
    if (indices.length !== 3) throw new MathInputProblem('syntax','曲面の三角形の点数が不正です。');
    const a = functionWorkCounter(indices[0],vertices.length-1), b = functionWorkCounter(indices[1],vertices.length-1), c = functionWorkCounter(indices[2],vertices.length-1);
    if (a === b || a === c || b === c) throw new MathInputProblem('syntax','曲面の三角形で同じ点が重複しています。');
    triangles.push(Object.freeze([a,b,c]));
  }
  const smooth = 'spline' in raw ? yield* spline(raw.spline,request,{vertices,triangles,bound:error}) : undefined;
  let declined: FunctionSurfaceSplineDeclined | undefined;
  if ('splineDeclined' in raw) {
    declined = DECLINED.find(reason => reason === raw.splineDeclined);
    if (declined === undefined) throw new MathInputProblem('syntax','曲面の滑らかな面を省いた理由を確認できません。');
  }
  return Object.freeze({status:'ready',vertices:Object.freeze(vertices),triangles:Object.freeze(triangles),maximumInterpolationErrorBound:error,stats:sampled,
    ...(smooth === undefined ? {} : {spline:smooth}),...(declined === undefined ? {} : {splineDeclined:declined})});
}

/** A reply whose envelope (kind, serial, identity) is checked; its result is decoded and verified by `steps`. */
export interface FunctionSurfaceReplyStart {
  readonly serial: number;
  readonly identity: MathRequestIdentity;
  /** Lazy: nothing of the result is read before the first step; finishing yields the whole frozen reply. */
  readonly steps: Steps<FunctionSurfaceWorkReply>;
}
/**
 * The cheap envelope check only. A reply for another editing state, or (by the caller's serial comparison) for
 * another request, is rejected here before any of its mesh or spline is read.
 */
export function beginFunctionSurfaceWorkReply(value: unknown, request: FunctionSurfaceWorkRequest): FunctionSurfaceReplyStart {
  const raw = functionWorkRecord(value,['kind','serial','identity','result']);
  if (raw.kind !== 'function-surface-result') throw new MathInputProblem('syntax','曲面の返信の種類が不正です。');
  const serial = functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1), identity = decodeMathRequestIdentity(raw.identity);
  if (!sameMathIdentity(identity,request.identity)) throw new MathInputProblem('syntax','別の編集状態の曲面を反映できません。');
  function* steps(): Steps<FunctionSurfaceWorkReply> {
    const decoded = yield* result(raw.result,request);
    return Object.freeze({kind:'function-surface-result',serial,identity,result:decoded});
  }
  return {serial,identity,steps:steps()};
}
/** The whole decode on the current thread (tests and synchronous callers); identical checks and result. */
export function decodeFunctionSurfaceWorkReply(value: unknown, request: FunctionSurfaceWorkRequest): FunctionSurfaceWorkReply {
  return completeSteps(beginFunctionSurfaceWorkReply(value, request).steps);
}
