/** Saved curve inputs are validated again before they can define a continuation request. */
import {hasFunctionDirection,decodeFunctionDirection,decodeFunctionDirectionEndpoint,type FunctionDirectionOptions,type WithFunctionDirection} from './functionDirectionContract.js';
import {MathInputProblem} from './mathInputContract.js';
import {functionWorkCounter,functionWorkRecord} from './functionWorkData.js';
import {decodeMathRequestIdentity,type MathRequestIdentity} from './mathWorkRequest.js';
import {sameMathIdentity} from './mathWorkerClient.js';
import {saveCurvePointInput,type CurvePointSavedInput,type CurvePointCandidate} from './curvePointWorkRequest.js';
import {decodeCurvePointCandidate,decodeCurvePointLocation} from './curvePointWorkReply.js';
import type {CurvePointContinuation} from './continueCurveFunctionPoint.js';

export interface CurvePointContinuationWorkRequest {
  readonly identity:MathRequestIdentity;readonly previous:CurvePointSavedInput;readonly current:CurvePointSavedInput;
  readonly anchor:CurvePointCandidate['location'];
  readonly direction?:FunctionDirectionOptions;
}
export type CurvePointContinuationWorkResult=WithFunctionDirection<CurvePointContinuation>|{readonly status:'invalid';readonly message:string};
function invalid():never {throw new MathInputProblem('syntax','曲線上の点の保存条件と追従結果を確認できません。');}
function saved(value:unknown,identity:MathRequestIdentity):CurvePointSavedInput {
  const raw=functionWorkRecord(value,['kind','independent','outputs','lower','upper','minimum','maximum','tolerance','coefficients','known']);
  return saveCurvePointInput({...raw,identity});
}
export function decodeCurvePointContinuationWorkRequest(value:unknown):CurvePointContinuationWorkRequest {
  const raw=functionWorkRecord(value,['identity','previous','current','anchor',...(hasFunctionDirection(value)?['direction']:[])]),identity=decodeMathRequestIdentity(raw.identity);
  const previous=saved(raw.previous,identity),current=saved(raw.current,identity),anchor=decodeCurvePointLocation(raw.anchor,{...previous,identity});
  return Object.freeze({identity,previous,current,anchor,...(hasFunctionDirection(raw)?{direction:decodeFunctionDirection(raw.direction)}:{})});
}
export function createCurvePointContinuationWorkEnvelope(serial:number,request:CurvePointContinuationWorkRequest) {
  return Object.freeze({kind:'continue-curve-point' as const,serial:functionWorkCounter(serial,Number.MAX_SAFE_INTEGER,1),
    request:decodeCurvePointContinuationWorkRequest(request)});
}
export function decodeCurvePointContinuationWorkReply(value:unknown,request:CurvePointContinuationWorkRequest) {
  const raw=functionWorkRecord(value,['kind','serial','identity','result']),identity=decodeMathRequestIdentity(raw.identity);
  if(raw.kind!=='curve-point-continuation-result' || !sameMathIdentity(identity,request.identity)) return invalid();
  const input=raw.result;if(input===null || typeof input!=='object' || !('status' in input)) return invalid();
  let result:CurvePointContinuationWorkResult;
  if(input.status==='ready') {
    const value=functionWorkRecord(input,['status','candidate',...(request.direction?['endpoint']:[])]);const candidate=decodeCurvePointCandidate(value.candidate,{...request.current,identity});
    const endpoint=decodeFunctionDirectionEndpoint(value.endpoint,candidate,request.direction,request.current.tolerance);
    result={status:'ready',candidate,...(endpoint?{endpoint}:{})};
  } else if(input.status==='unresolved') {
    const value=functionWorkRecord(input,['status','reason']);
    if(value.reason!=='formula-changed' && value.reason!=='invalid-anchor' && value.reason!=='branch-missing' && value.reason!=='branch-unproved') return invalid();
    result={status:'unresolved',reason:value.reason};
  } else if(input.status==='stopped') {
    const value=functionWorkRecord(input,['status','reason']);if(value.reason!=='cancelled' && value.reason!=='deadline' && value.reason!=='budget') return invalid();
    result={status:'stopped',reason:value.reason};
  } else if(input.status==='invalid') {
    const value=functionWorkRecord(input,['status','message']);if(typeof value.message!=='string' || value.message.length<1 || value.message.length>2048) return invalid();
    result={status:'invalid',message:value.message};
  } else return invalid();
  return Object.freeze({kind:'curve-point-continuation-result' as const,serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),identity,result:Object.freeze(result)});
}
