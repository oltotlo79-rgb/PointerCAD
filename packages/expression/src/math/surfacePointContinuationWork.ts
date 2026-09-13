/** Revalidate saved surface inputs and U/V branch locations at every persistence boundary. */
import {hasFunctionDirection,decodeFunctionDirection,decodeFunctionDirectionEndpoint,type FunctionDirectionOptions,type WithFunctionDirection} from './functionDirectionContract.js';
import {MathInputProblem} from './mathInputContract.js';
import {functionWorkCounter,functionWorkRecord} from './functionWorkData.js';
import {decodeMathRequestIdentity,type MathRequestIdentity} from './mathWorkRequest.js';
import {sameMathIdentity} from './mathWorkerClient.js';
import {saveSurfacePointInput,type SurfacePointSavedInput,type SurfacePointCandidate} from './surfacePointWorkRequest.js';
import {decodeSurfacePointCandidate,decodeSurfacePointLocation} from './surfacePointWorkReply.js';
import type {SurfacePointContinuation} from './continueSurfaceFunctionPoint.js';

export interface SurfacePointContinuationWorkRequest {
  readonly identity:MathRequestIdentity;readonly previous:SurfacePointSavedInput;readonly current:SurfacePointSavedInput;
  readonly anchor:SurfacePointCandidate['location'];
  readonly direction?:FunctionDirectionOptions;
}
export type SurfacePointContinuationWorkResult=WithFunctionDirection<SurfacePointContinuation>|{readonly status:'invalid';readonly message:string};
function invalid():never{throw new MathInputProblem('syntax','曲面上の点の保存条件と追従結果を確認できません。');}
function saved(value:unknown,identity:MathRequestIdentity):SurfacePointSavedInput {
  const hasBounds=value!==null&&typeof value==='object'&&Object.hasOwn(value,'parameterBounds');
  const raw=functionWorkRecord(value,['kind','independent','outputs','lower','upper','minimum','maximum','tolerance','budget','coefficients','known',
    ...(hasBounds?['parameterBounds']:[])]);
  return saveSurfacePointInput({...raw,identity});
}
export function decodeSurfacePointContinuationWorkRequest(value:unknown):SurfacePointContinuationWorkRequest {
  const raw=functionWorkRecord(value,['identity','previous','current','anchor',...(hasFunctionDirection(value)?['direction']:[])]),identity=decodeMathRequestIdentity(raw.identity);
  const previous=saved(raw.previous,identity),current=saved(raw.current,identity),anchor=decodeSurfacePointLocation(raw.anchor,{...previous,identity});
  return Object.freeze({identity,previous,current,anchor,...(hasFunctionDirection(raw)?{direction:decodeFunctionDirection(raw.direction)}:{})});
}
export function createSurfacePointContinuationWorkEnvelope(serial:number,request:SurfacePointContinuationWorkRequest) {
  return Object.freeze({kind:'continue-surface-point' as const,serial:functionWorkCounter(serial,Number.MAX_SAFE_INTEGER,1),
    request:decodeSurfacePointContinuationWorkRequest(request)});
}
export function decodeSurfacePointContinuationWorkReply(value:unknown,request:SurfacePointContinuationWorkRequest) {
  const raw=functionWorkRecord(value,['kind','serial','identity','result']),identity=decodeMathRequestIdentity(raw.identity);
  if(raw.kind!=='surface-point-continuation-result'||!sameMathIdentity(identity,request.identity))return invalid();
  const input=raw.result;if(input===null||typeof input!=='object'||!('status' in input))return invalid();
  let result:SurfacePointContinuationWorkResult;
  if(input.status==='ready'){
    const value=functionWorkRecord(input,['status','candidate',...(request.direction?['endpoint']:[])]);const candidate=decodeSurfacePointCandidate(value.candidate,{...request.current,identity});
    const endpoint=decodeFunctionDirectionEndpoint(value.endpoint,candidate,request.direction,request.current.tolerance);
    result={status:'ready',candidate,...(endpoint?{endpoint}:{})};
  }else if(input.status==='unresolved'){
    const value=functionWorkRecord(input,['status','reason']);
    if(value.reason!=='formula-changed'&&value.reason!=='invalid-anchor'&&value.reason!=='branch-missing'&&value.reason!=='branch-unproved')return invalid();
    result={status:'unresolved',reason:value.reason};
  }else if(input.status==='stopped'){
    const value=functionWorkRecord(input,['status','reason']);if(value.reason!=='cancelled'&&value.reason!=='deadline'&&value.reason!=='budget')return invalid();
    result={status:'stopped',reason:value.reason};
  }else if(input.status==='invalid'){
    const value=functionWorkRecord(input,['status','message']);if(typeof value.message!=='string'||value.message.length<1||value.message.length>2048)return invalid();
    result={status:'invalid',message:value.message};
  }else return invalid();
  return Object.freeze({kind:'surface-point-continuation-result' as const,serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),identity,result:Object.freeze(result)});
}
