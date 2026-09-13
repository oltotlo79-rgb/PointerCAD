/** No received surface reaches CAD until its identity, bounds, topology indices and error budget are checked. */
import { MathInputProblem } from './mathInputContract.js';
import { decodeMathRequestIdentity } from './mathWorkRequest.js';
import { sameMathIdentity } from './mathWorkerClient.js';
import { functionWorkRecord, functionWorkArray, functionWorkCounter, functionWorkNumber, functionWorkPair, functionWorkPoint } from './functionWorkData.js';
import type { FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import type { FunctionSurfaceWorkReply, FunctionSurfaceWorkResult } from './functionSurfaceWorkExecution.js';
import type { FunctionSurfaceStats, FunctionSurfaceVertex } from './adaptiveFunctionSurface.js';

function stats(value: unknown, request: FunctionSurfaceWorkRequest): FunctionSurfaceStats {
  const raw = functionWorkRecord(value,['samples','cells','triangles']);
  return Object.freeze({samples:functionWorkCounter(raw.samples,request.budget.maximumSamples),
    cells:functionWorkCounter(raw.cells,request.budget.maximumCells),triangles:functionWorkCounter(raw.triangles,request.budget.maximumTriangles)});
}
function result(value: unknown, request: FunctionSurfaceWorkRequest): FunctionSurfaceWorkResult {
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
  const raw = functionWorkRecord(value,['status','vertices','triangles','maximumInterpolationErrorBound','stats']);
  const sampled = stats(raw.stats,request), error = functionWorkNumber(raw.maximumInterpolationErrorBound);
  if (error < 0 || error > request.tolerance) throw new MathInputProblem('domain','曲面の作図精度を確認できません。');
  const points = functionWorkArray(raw.vertices,sampled.samples), elements = functionWorkArray(raw.triangles,sampled.triangles);
  if (points.length < 3 || elements.length === 0 || elements.length !== sampled.triangles) throw new MathInputProblem('syntax','曲面の点数または面数が一致しません。');
  const vertices: FunctionSurfaceVertex[] = [];
  for (const point of points) {
    const entry = functionWorkRecord(point,['parameters','point']), parameters = functionWorkPair(entry.parameters);
    if (parameters.some((coordinate,axis)=>coordinate < request.lower[axis] || coordinate > request.upper[axis])) {
      throw new MathInputProblem('domain','曲面の標本が指定した変数の範囲外です。');
    }
    // World positions may lie outside the XYZ box until the following actual CAD clipping step.
    vertices.push(Object.freeze({parameters,point:functionWorkPoint(entry.point)}));
  }
  const triangles: (readonly [number,number,number])[] = [];
  for (const element of elements) {
    const indices = functionWorkArray(element,3);
    if (indices.length !== 3) throw new MathInputProblem('syntax','曲面の三角形の点数が不正です。');
    const a = functionWorkCounter(indices[0],vertices.length-1), b = functionWorkCounter(indices[1],vertices.length-1), c = functionWorkCounter(indices[2],vertices.length-1);
    if (a === b || a === c || b === c) throw new MathInputProblem('syntax','曲面の三角形で同じ点が重複しています。');
    triangles.push(Object.freeze([a,b,c]));
  }
  return Object.freeze({status:'ready',vertices:Object.freeze(vertices),triangles:Object.freeze(triangles),maximumInterpolationErrorBound:error,stats:sampled});
}
export function decodeFunctionSurfaceWorkReply(value: unknown, request: FunctionSurfaceWorkRequest): FunctionSurfaceWorkReply {
  const raw = functionWorkRecord(value,['kind','serial','identity','result']);
  if (raw.kind !== 'function-surface-result') throw new MathInputProblem('syntax','曲面の返信の種類が不正です。');
  const serial = functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1), identity = decodeMathRequestIdentity(raw.identity);
  if (!sameMathIdentity(identity,request.identity)) throw new MathInputProblem('syntax','別の編集状態の曲面を反映できません。');
  return Object.freeze({kind:'function-surface-result',serial,identity,result:result(raw.result,request)});
}
