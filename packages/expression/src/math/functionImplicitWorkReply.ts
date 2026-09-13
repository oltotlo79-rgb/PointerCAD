import { MathInputProblem } from './mathInputContract.js';
import { decodeMathRequestIdentity } from './mathWorkRequest.js';
import { sameMathIdentity } from './mathWorkerClient.js';
import { functionWorkArray, functionWorkCounter, functionWorkNumber, functionWorkPoint, functionWorkRecord } from './functionWorkData.js';
import type { FunctionImplicitWorkRequest } from './functionImplicitWorkRequest.js';
import { IMPLICIT_STOP_REASONS, type FunctionImplicitStats, type FunctionImplicitWorkReply, type FunctionImplicitWorkResult } from './functionImplicitProtocol.js';
import { decodeImplicitPrimitiveReply } from './implicitPrimitiveReply.js';

function stats(value:unknown,request:FunctionImplicitWorkRequest):FunctionImplicitStats {
  const raw=functionWorkRecord(value,['gridSamples','cells','vertices','triangles']);
  return Object.freeze({gridSamples:functionWorkCounter(raw.gridSamples,request.budget.maximumSamples),
    cells:functionWorkCounter(raw.cells,request.budget.maximumCells),vertices:functionWorkCounter(raw.vertices,request.budget.maximumSamples),
    triangles:functionWorkCounter(raw.triangles,request.budget.maximumTriangles)});
}
function decodeResult(value:unknown,request:FunctionImplicitWorkRequest):FunctionImplicitWorkResult {
  if(value===null || typeof value!=='object' || !('status' in value)) throw new MathInputProblem('syntax','陰関数の結果を確認できません。');
  if(value.status==='analytic') return decodeImplicitPrimitiveReply(value,request);
  if(value.status==='invalid'){
    const raw=functionWorkRecord(value,['status','message']);
    if(typeof raw.message!=='string' || raw.message.length<1 || raw.message.length>2048) throw new MathInputProblem('syntax','陰関数の失敗理由を確認できません。');
    return Object.freeze({status:'invalid',message:raw.message});
  }
  if(value.status==='empty' || value.status==='degenerate'){
    const raw=functionWorkRecord(value,['status','stats']); return Object.freeze({status:value.status,stats:stats(raw.stats,request)});
  }
  if(value.status==='stopped'){
    const raw=functionWorkRecord(value,['status','reason','stats']);
    const reason=IMPLICIT_STOP_REASONS.find(reason=>reason===raw.reason);
    if(reason===undefined) throw new MathInputProblem('syntax','陰関数の停止理由を確認できません。');
    return Object.freeze({status:'stopped',reason,stats:stats(raw.stats,request)});
  }
  if(value.status!=='ready') throw new MathInputProblem('syntax','陰関数の結果の種類が不正です。');
  const raw=functionWorkRecord(value,['status','mesh','maximumDistanceBound','stats']),counts=stats(raw.stats,request);
  const diameter=functionWorkNumber(raw.maximumDistanceBound);
  if(diameter<=0 || diameter>request.tolerance) throw new MathInputProblem('domain','陰関数の作図精度を確認できません。');
  const mesh=functionWorkRecord(raw.mesh,['vertices','triangles']);
  const vertices=functionWorkArray(mesh.vertices,counts.vertices).map(value=>{
    const point=functionWorkPoint(value);
    if(point.some((coordinate,axis)=>coordinate<request.minimum[axis] || coordinate>request.maximum[axis])) throw new MathInputProblem('domain','陰関数の点がXYZの指定範囲外です。');
    return point;
  });
  const triangles=functionWorkArray(mesh.triangles,counts.triangles).map(value=>{
    const raw=functionWorkArray(value,3); if(raw.length!==3) throw new MathInputProblem('syntax','陰関数の面の点数が不正です。');
    const a=functionWorkCounter(raw[0],vertices.length-1),b=functionWorkCounter(raw[1],vertices.length-1),c=functionWorkCounter(raw[2],vertices.length-1);
    if(a===b || b===c || a===c) throw new MathInputProblem('syntax','陰関数の面で同じ点が重複しています。');
    return Object.freeze([a,b,c] as const);
  });
  if(vertices.length!==counts.vertices || triangles.length!==counts.triangles || vertices.length<3 || triangles.length<1) throw new MathInputProblem('syntax','陰関数の点数と面数が一致しません。');
  return Object.freeze({status:'ready',mesh:Object.freeze({vertices:Object.freeze(vertices),triangles:Object.freeze(triangles)}),maximumDistanceBound:diameter,stats:counts});
}
export function decodeFunctionImplicitWorkReply(value:unknown,request:FunctionImplicitWorkRequest):FunctionImplicitWorkReply {
  const raw=functionWorkRecord(value,['kind','serial','identity','result']),identity=decodeMathRequestIdentity(raw.identity);
  if(raw.kind!=='function-implicit-surface-result' || !sameMathIdentity(identity,request.identity)) throw new MathInputProblem('syntax','別の編集状態の陰関数を反映できません。');
  return Object.freeze({kind:'function-implicit-surface-result',serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),identity,result:decodeResult(raw.result,request)});
}
