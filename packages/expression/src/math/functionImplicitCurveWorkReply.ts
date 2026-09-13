import { MathInputProblem } from './mathInputContract.js';
import { decodeMathRequestIdentity } from './mathWorkRequest.js';
import { sameMathIdentity } from './mathWorkerClient.js';
import { functionWorkArray,functionWorkCounter,functionWorkNumber,functionWorkPoint,functionWorkRecord } from './functionWorkData.js';
import type { FunctionImplicitCurveWorkRequest } from './functionImplicitCurveWorkRequest.js';
import { IMPLICIT_CURVE_STOP_REASONS,type FunctionImplicitCurveStats,type FunctionImplicitCurveWorkReply,type FunctionImplicitCurveWorkResult } from './functionImplicitCurveProtocol.js';

function stats(value:unknown,request:FunctionImplicitCurveWorkRequest):FunctionImplicitCurveStats {
  const raw=functionWorkRecord(value,['gridSamples','cells','vertices','segments']);
  return Object.freeze({gridSamples:functionWorkCounter(raw.gridSamples,request.budget.maximumSamples),cells:functionWorkCounter(raw.cells,request.budget.maximumCells),
    vertices:functionWorkCounter(raw.vertices,request.budget.maximumSamples),segments:functionWorkCounter(raw.segments,request.budget.maximumSegments)});
}
function decodeResult(value:unknown,request:FunctionImplicitCurveWorkRequest):FunctionImplicitCurveWorkResult {
  if(value===null || typeof value!=='object' || !('status' in value)) throw new MathInputProblem('syntax','平面等式の結果を確認できません。');
  if(value.status==='invalid'){
    const raw=functionWorkRecord(value,['status','message']);
    if(typeof raw.message!=='string' || raw.message.length<1 || raw.message.length>2048) throw new MathInputProblem('syntax','平面等式の失敗理由を確認できません。');
    return Object.freeze({status:'invalid',message:raw.message});
  }
  if(value.status==='empty' || value.status==='degenerate'){
    const raw=functionWorkRecord(value,['status','stats']);return Object.freeze({status:value.status,stats:stats(raw.stats,request)});
  }
  if(value.status==='stopped'){
    const raw=functionWorkRecord(value,['status','reason','stats']),reason=IMPLICIT_CURVE_STOP_REASONS.find(reason=>reason===raw.reason);
    if(reason===undefined) throw new MathInputProblem('syntax','平面等式の停止理由を確認できません。');
    return Object.freeze({status:'stopped',reason,stats:stats(raw.stats,request)});
  }
  if(value.status!=='ready') throw new MathInputProblem('syntax','平面等式の結果の種類が不正です。');
  const raw=functionWorkRecord(value,['status','components','maximumDistanceBound','stats']),counts=stats(raw.stats,request);
  const error=functionWorkNumber(raw.maximumDistanceBound);
  if(error<=0 || error>request.tolerance) throw new MathInputProblem('domain','平面等式の作図精度を確認できません。');
  const fixedAxis=request.fixedAxis==='X'?0:request.fixedAxis==='Y'?1:2;
  let pointCount=0,segmentCount=0;
  const components=functionWorkArray(raw.components,counts.segments).map(component=>{
    const points=functionWorkArray(component,counts.vertices+1).map(value=>{
      if(++pointCount>counts.vertices+counts.segments) throw new MathInputProblem('budget','平面等式の点数が上限を超えています。');
      const point=functionWorkPoint(value);
      if(point[fixedAxis]!==request.fixedCoordinate || point.some((coordinate,axis)=>coordinate<request.minimum[axis] || coordinate>request.maximum[axis])) {
        throw new MathInputProblem('domain','平面等式の点が指定平面またはXYZの範囲外です。');
      }
      return point;
    });
    if(points.length<2) throw new MathInputProblem('syntax','平面等式の曲線には2つ以上の点が必要です。');
    for(let index=1;index<points.length;index++) if(points[index].every((value,axis)=>value===points[index-1][axis])) {
      throw new MathInputProblem('syntax','平面等式の曲線で隣り合う点が重複しています。');
    }
    segmentCount+=points.length-1;return Object.freeze(points);
  });
  if(components.length===0 || segmentCount!==counts.segments || pointCount>counts.vertices+components.length) {
    throw new MathInputProblem('syntax','平面等式の点数・線分数・成分数が一致しません。');
  }
  return Object.freeze({status:'ready',components:Object.freeze(components),maximumDistanceBound:error,stats:counts});
}
export function decodeFunctionImplicitCurveWorkReply(value:unknown,request:FunctionImplicitCurveWorkRequest):FunctionImplicitCurveWorkReply {
  const raw=functionWorkRecord(value,['kind','serial','identity','result']),identity=decodeMathRequestIdentity(raw.identity);
  if(raw.kind!=='function-implicit-curve-result' || !sameMathIdentity(identity,request.identity)) throw new MathInputProblem('syntax','別の編集状態の平面等式を反映できません。');
  return Object.freeze({kind:'function-implicit-curve-result',serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),identity,result:decodeResult(raw.result,request)});
}
