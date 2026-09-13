/** Re-evaluate the saved choice in a disposable Worker; the prior source is input, never cached coordinates. */
import {hasFunctionDirection,decodeFunctionDirection,decodeFunctionDirectionEndpoint,type FunctionDirectionOptions,type WithFunctionDirection} from './functionDirectionContract.js';
import {MathInputProblem} from './mathInputContract.js';
import {functionWorkCounter,functionWorkNumber,functionWorkRecord} from './functionWorkData.js';
import {functionPointAxis,saveFunctionPointInput,type FunctionPointSavedInput} from './functionPointWorkRequest.js';
import {decodeFunctionPointCandidate} from './functionPointWorkReply.js';
import {decodeMathRequestIdentity,type MathRequestIdentity} from './mathWorkRequest.js';
import {sameMathIdentity} from './mathWorkerClient.js';
import type {FunctionPointContinuation} from './continueImplicitFunctionPoint.js';
import type {FunctionPointCandidate} from './functionPointCandidates.js';

export type {FunctionPointSavedInput} from './functionPointWorkRequest.js';
export interface FunctionPointContinuationWorkRequest {
  readonly identity:MathRequestIdentity;
  readonly previous:FunctionPointSavedInput;readonly current:FunctionPointSavedInput;
  readonly anchor:FunctionPointCandidate['location'];
  readonly direction?:FunctionDirectionOptions;
}
export type FunctionPointContinuationWorkResult=WithFunctionDirection<FunctionPointContinuation>|{readonly status:'invalid';readonly message:string};
function invalid():never {throw new MathInputProblem('syntax','関数上の点の追従条件を確認できません。');}
function savedInput(value:unknown,identity:MathRequestIdentity):FunctionPointSavedInput {
  const hasFixed=value!==null && typeof value==='object' && Object.hasOwn(value,'fixed');
  const raw=functionWorkRecord(value,['expression','minimum','maximum','tolerance','coefficients','known',...(hasFixed?['fixed']:[])]);
  return saveFunctionPointInput({...raw,identity});
}
export function decodeFunctionPointContinuationWorkRequest(value:unknown):FunctionPointContinuationWorkRequest {
  const raw=functionWorkRecord(value,['identity','previous','current','anchor',...(hasFunctionDirection(value)?['direction']:[])]),identity=decodeMathRequestIdentity(raw.identity);
  const previous=savedInput(raw.previous,identity),current=savedInput(raw.current,identity);
  let anchor:FunctionPointCandidate['location'];
  if(raw.anchor!==null && typeof raw.anchor==='object' && 'kind' in raw.anchor && raw.anchor.kind==='direct'){
    functionWorkRecord(raw.anchor,['kind']);anchor=Object.freeze({kind:'direct'});
  } else {
    const choice=functionWorkRecord(raw.anchor,['kind','axis','interval']),axis=functionPointAxis(choice.axis),index=['X','Y','Z'].indexOf(axis);
    const range=functionWorkRecord(choice.interval,['lower','upper']),lower=functionWorkNumber(range.lower),upper=functionWorkNumber(range.upper);
    if(choice.kind!=='implicit' || lower>upper || lower<previous.minimum[index] || upper>previous.maximum[index]
      || upper-lower>previous.tolerance) return invalid();
    anchor=Object.freeze({kind:'implicit',axis,interval:Object.freeze({lower,upper})});
  }
  return Object.freeze({identity,previous,current,anchor,...(hasFunctionDirection(raw)?{direction:decodeFunctionDirection(raw.direction)}:{})});
}
export function createFunctionPointContinuationWorkEnvelope(serial:number,request:FunctionPointContinuationWorkRequest){
  return Object.freeze({kind:'continue-function-point' as const,serial:functionWorkCounter(serial,Number.MAX_SAFE_INTEGER,1),
    request:decodeFunctionPointContinuationWorkRequest(request)});
}
export function decodeFunctionPointContinuationWorkReply(value:unknown,request:FunctionPointContinuationWorkRequest){
  const raw=functionWorkRecord(value,['kind','serial','identity','result']),identity=decodeMathRequestIdentity(raw.identity);
  if(raw.kind!=='function-point-continuation-result' || !sameMathIdentity(identity,request.identity)) return invalid();
  const input=raw.result;if(input===null || typeof input!=='object' || !('status' in input)) return invalid();
  let result:FunctionPointContinuationWorkResult;
  if(input.status==='ready'){
    const value=functionWorkRecord(input,['status','candidate',...(request.direction?['endpoint']:[])]);
    const candidate=decodeFunctionPointCandidate(value.candidate,{...request.current,identity});
    const endpoint=decodeFunctionDirectionEndpoint(value.endpoint,candidate,request.direction,request.current.tolerance);
    result={status:'ready',candidate,...(endpoint?{endpoint}:{})};
  }else if(input.status==='unresolved'){
    const value=functionWorkRecord(input,['status','reason']);
    if(value.reason!=='formula-changed' && value.reason!=='invalid-anchor' && value.reason!=='branch-missing' && value.reason!=='branch-unproved') return invalid();
    result={status:'unresolved',reason:value.reason};
  }else if(input.status==='stopped'){
    const value=functionWorkRecord(input,['status','reason']);
    if(value.reason!=='cancelled' && value.reason!=='deadline' && value.reason!=='budget') return invalid();
    result={status:'stopped',reason:value.reason};
  }else if(input.status==='invalid'){
    const value=functionWorkRecord(input,['status','message']);
    if(typeof value.message!=='string' || value.message.length<1 || value.message.length>2048) return invalid();
    result={status:'invalid',message:value.message};
  }else return invalid();
  return Object.freeze({kind:'function-point-continuation-result' as const,identity,serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),result:Object.freeze(result)});
}
