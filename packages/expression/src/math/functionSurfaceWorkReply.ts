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

/** Internal transport only. The public result and stored geometry retain their existing shapes. */
const PACKED_VERSION = 1;
function packedProblem(): never { throw new MathInputProblem('syntax', '曲面の転送データを確認できません。'); }
function tuple(value: unknown, width: number): readonly unknown[] {
  const row = functionWorkArray(value, width);
  if (row.length !== width) packedProblem();
  return row;
}
/** Allocate our own buffers: transferring a reply must never detach a sampler/cache-owned buffer. */
export function packFunctionSurfaceWorkReply(value: unknown): { message: unknown; transfer: ArrayBuffer[] } {
  const transfer: ArrayBuffer[] = [];
  if (value === null || typeof value !== 'object' || !('kind' in value) || value.kind !== 'function-surface-result') return { message: value, transfer };
  const envelope = functionWorkRecord(value, ['kind', 'serial', 'identity', 'result']);
  if (envelope.result === null || typeof envelope.result !== 'object' || !('status' in envelope.result)
    || envelope.result.status !== 'ready') return { message: value, transfer };
  const ready = envelope.result;
  const raw = functionWorkRecord(ready, ['status', 'vertices', 'triangles', 'maximumInterpolationErrorBound', 'stats',
    ...('spline' in ready ? ['spline'] : []), ...('splineDeclined' in ready ? ['splineDeclined'] : [])]);
  const points = functionWorkArray(raw.vertices, 0xffff_ffff), triangles = functionWorkArray(raw.triangles, 0xffff_ffff);
  const vertices = new Float64Array(points.length * 5), indices = new Uint32Array(triangles.length * 3);
  for (let index = 0; index < points.length; index++) {
    const entry = functionWorkRecord(points[index], ['parameters', 'point']);
    const parameters = tuple(entry.parameters, 2), point = tuple(entry.point, 3);
    for (let axis = 0; axis < 5; axis++) vertices[5 * index + axis] = functionWorkNumber(axis < 2 ? parameters[axis] : point[axis - 2]);
  }
  for (let index = 0; index < triangles.length; index++) {
    const row = tuple(triangles[index], 3);
    // Validate before assigning to Uint32: conversion must not round/wrap an invalid index into a valid one.
    for (let axis = 0; axis < 3; axis++) indices[3 * index + axis] = functionWorkCounter(row[axis], points.length - 1);
  }
  transfer.push(vertices.buffer, indices.buffer);
  let smooth: Record<string, unknown> | undefined;
  if ('spline' in raw) {
    const original = functionWorkRecord(raw.spline, ['uKnots', 'vKnots', 'poles', 'errorBound']);
    const rows = functionWorkArray(original.poles, FUNCTION_SURFACE_SPLINE_POLE_LIMIT), poles = new Float64Array(rows.length * 3);
    for (let index = 0; index < rows.length; index++) {
      const row = tuple(rows[index], 3);
      for (let axis = 0; axis < 3; axis++) poles[3 * index + axis] = functionWorkNumber(row[axis]);
    }
    transfer.push(poles.buffer);
    smooth = { ...original, poles: poles.buffer };
  }
  return { message: { ...envelope, result: { ...raw, wireVersion: PACKED_VERSION, vertices: vertices.buffer,
    triangles: indices.buffer, ...(smooth === undefined ? {} : { spline: smooth }) } }, transfer };
}

/** Views are cheap; individual rows are validated by the existing sliced decoder, never inflated in one task. */
function rowsOf(value: unknown, width: number, maximum: number, packed: boolean, buffers: Set<ArrayBuffer>, indices = false) {
  if (!packed) {
    const rows = functionWorkArray(value, maximum);
    return { length: rows.length, at: (index: number): unknown => rows[index] };
  }
  const stride = width * (indices ? Uint32Array.BYTES_PER_ELEMENT : Float64Array.BYTES_PER_ELEMENT);
  if (!(value instanceof ArrayBuffer) || buffers.has(value) || value.byteLength % stride !== 0 || value.byteLength / stride > maximum) packedProblem();
  buffers.add(value);
  const values = indices ? new Uint32Array(value) : new Float64Array(value);
  return { length: values.length / width, at: (index: number): unknown => {
    const row: number[] = [];
    for (let axis = 0; axis < width; axis++) row.push(values[index * width + axis]);
    return row;
  } };
}

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
function* spline(value: unknown, request: FunctionSurfaceWorkRequest, mesh: SurfaceMeshEvidence, packed: boolean, buffers: Set<ArrayBuffer>): Steps<FunctionSurfaceSpline> {
  const raw = functionWorkRecord(value, ['uKnots', 'vKnots', 'poles', 'errorBound']);
  const uKnots = yield* knotsOf(raw.uKnots, request.lower[0], request.upper[0]), vKnots = yield* knotsOf(raw.vKnots, request.lower[1], request.upper[1]);
  const count = 4 * uKnots.length * vKnots.length;
  if (count > FUNCTION_SURFACE_SPLINE_POLE_LIMIT) throw new MathInputProblem('budget', '曲面の滑らかな面の制御点数が上限を超えています。');
  const rawPoles = rowsOf(raw.poles, 3, count, packed, buffers), poles: ReturnType<typeof functionWorkPoint>[] = [];
  for (let index = 0; index < rawPoles.length; index++) {
    if (index % STEP_ELEMENTS === 0) yield;
    poles.push(functionWorkPoint(rawPoles.at(index)));
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
  const packed = 'wireVersion' in value;
  if (packed && value.wireVersion !== PACKED_VERSION) packedProblem();
  const buffers = new Set<ArrayBuffer>();
  const raw = functionWorkRecord(value,['status','vertices','triangles','maximumInterpolationErrorBound','stats',
    ...('spline' in value ? ['spline'] : []), ...('splineDeclined' in value ? ['splineDeclined'] : []), ...(packed ? ['wireVersion'] : [])]);
  if ('spline' in raw && 'splineDeclined' in raw) throw new MathInputProblem('syntax','曲面の滑らかな面の状態が矛盾しています。');
  const sampled = stats(raw.stats,request), error = functionWorkNumber(raw.maximumInterpolationErrorBound);
  if (error < 0 || error > request.tolerance) throw new MathInputProblem('domain','曲面の作図精度を確認できません。');
  const points = rowsOf(raw.vertices,5,sampled.samples,packed,buffers), elements = rowsOf(raw.triangles,3,sampled.triangles,packed,buffers,true);
  if (points.length < 3 || elements.length === 0 || elements.length !== sampled.triangles) throw new MathInputProblem('syntax','曲面の点数または面数が一致しません。');
  const vertices: FunctionSurfaceVertex[] = [];
  for (let index = 0; index < points.length; index++) {
    if (index % STEP_ELEMENTS === 0) yield;
    const point = points.at(index), row = packed ? tuple(point, 5) : undefined;
    const entry = row === undefined ? functionWorkRecord(point,['parameters','point'])
      : { parameters: [row[0], row[1]], point: [row[2], row[3], row[4]] };
    const parameters = functionWorkPair(entry.parameters);
    if (parameters.some((coordinate,axis)=>coordinate < request.lower[axis] || coordinate > request.upper[axis])) {
      throw new MathInputProblem('domain','曲面の標本が指定した変数の範囲外です。');
    }
    // World positions may lie outside the XYZ box until the following actual CAD clipping step.
    vertices.push(Object.freeze({parameters,point:functionWorkPoint(entry.point)}));
  }
  const triangles: (readonly [number,number,number])[] = [];
  for (let index = 0; index < elements.length; index++) {
    if (index % STEP_ELEMENTS === 0) yield;
    const indices = functionWorkArray(elements.at(index),3);
    if (indices.length !== 3) throw new MathInputProblem('syntax','曲面の三角形の点数が不正です。');
    const a = functionWorkCounter(indices[0],vertices.length-1), b = functionWorkCounter(indices[1],vertices.length-1), c = functionWorkCounter(indices[2],vertices.length-1);
    if (a === b || a === c || b === c) throw new MathInputProblem('syntax','曲面の三角形で同じ点が重複しています。');
    triangles.push(Object.freeze([a,b,c]));
  }
  const smooth = 'spline' in raw ? yield* spline(raw.spline,request,{vertices,triangles,bound:error},packed,buffers) : undefined;
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
