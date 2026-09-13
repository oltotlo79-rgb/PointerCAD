/** Malformed, stale or out-of-domain Worker values never become point coordinates. */
import {MathInputProblem} from './mathInputContract.js';
import {decodeMathRequestIdentity} from './mathWorkRequest.js';
import {sameMathIdentity} from './mathWorkerClient.js';
import {functionWorkArray,functionWorkCounter,functionWorkNumber,functionWorkPoint,functionWorkRecord} from './functionWorkData.js';
import {functionPointAxis,type FunctionPointWorkRequest} from './functionPointWorkRequest.js';
import type {FunctionPointWorkResult,FunctionPointWorkReply} from './functionPointWorkExecution.js';
import type {FunctionPointCandidate} from './functionPointCandidates.js';

const AXES=['X','Y','Z'] as const;
function invalid():never {throw new MathInputProblem('syntax','関数上の点の結果と指定した座標・範囲を照合できません。');}
function interval(value:unknown){
  const raw=functionWorkRecord(value,['lower','upper']),lower=functionWorkNumber(raw.lower),upper=functionWorkNumber(raw.upper);
  if(lower>upper || !Number.isFinite(upper-lower)) return invalid();
  return Object.freeze({lower,upper});
}
export function decodeFunctionPointCandidate(value:unknown,request:FunctionPointWorkRequest):FunctionPointCandidate {
  const raw=functionWorkRecord(value,['point','minimum','maximum','location']);
  const point=functionWorkPoint(raw.point),minimum=functionWorkPoint(raw.minimum),maximum=functionWorkPoint(raw.maximum);
  if(point.some((value,axis)=>minimum[axis]>value || maximum[axis]<value || minimum[axis]<request.minimum[axis]
    || maximum[axis]>request.maximum[axis] || maximum[axis]-minimum[axis]>request.tolerance)) return invalid();
  const known=[...request.known,...(request.fixed?[request.fixed]:[])];
  if(known.some(item=>{const axis=AXES.indexOf(item.axis);return point[axis]!==item.value || minimum[axis]!==item.value || maximum[axis]!==item.value;})) return invalid();
  if(raw.location!==null && typeof raw.location==='object' && 'kind' in raw.location && raw.location.kind==='direct') {
    functionWorkRecord(raw.location,['kind']);
    return Object.freeze({point,minimum,maximum,location:Object.freeze({kind:'direct'})});
  }
  const location=functionWorkRecord(raw.location,['kind','axis','interval']),axis=functionPointAxis(location.axis),range=interval(location.interval),index=AXES.indexOf(axis);
  if(location.kind!=='implicit' || known.some(item=>item.axis===axis) || range.lower!==minimum[index] || range.upper!==maximum[index]
    || AXES.some(name=>name!==axis && !known.some(item=>item.axis===name))) return invalid();
  return Object.freeze({point,minimum,maximum,location:Object.freeze({kind:'implicit',axis,interval:range})});
}
function result(value:unknown,request:FunctionPointWorkRequest):FunctionPointWorkResult {
  if(value===null || typeof value!=='object' || !('status' in value)) return invalid();
  if(value.status==='invalid'){
    const raw=functionWorkRecord(value,['status','message']);
    if(typeof raw.message!=='string' || raw.message.length<1 || raw.message.length>2048) return invalid();
    return Object.freeze({status:'invalid',message:raw.message});
  }
  if(value.status==='stopped'){
    const raw=functionWorkRecord(value,['status','reason']);
    if(raw.reason!=='cancelled' && raw.reason!=='deadline' && raw.reason!=='budget') return invalid();
    return Object.freeze({status:'stopped',reason:raw.reason});
  }
  if(value.status==='underconstrained'){
    const raw=functionWorkRecord(value,['status','additionalCoordinates']);
    if(raw.additionalCoordinates!==1) return invalid();
    return Object.freeze({status:'underconstrained',additionalCoordinates:1});
  }
  if(value.status==='out-of-range'){
    const raw=functionWorkRecord(value,['status','axes']),axes=functionWorkArray(raw.axes,3).map(functionPointAxis);
    const outside=[...request.known,...(request.fixed?[request.fixed]:[])].filter(item=>{
      const axis=AXES.indexOf(item.axis);return item.value<request.minimum[axis] || item.value>request.maximum[axis];
    }).map(item=>item.axis);
    if(axes.length<1 || new Set(axes).size!==axes.length || axes.some(axis=>!outside.includes(axis)) || outside.some(axis=>!axes.includes(axis))) return invalid();
    return Object.freeze({status:'out-of-range',axes:Object.freeze(axes)});
  }
  if(value.status!=='ready') return invalid();
  const raw=functionWorkRecord(value,['status','candidates','exhaustive','unresolved']);
  const candidates=functionWorkArray(raw.candidates,1024).map(value=>decodeFunctionPointCandidate(value,request));
  const unresolved=functionWorkArray(raw.unresolved,1024-candidates.length).map(value=>{
    const raw=functionWorkRecord(value,['axis','interval','reason']),axis=functionPointAxis(raw.axis),range=interval(raw.interval),index=AXES.indexOf(axis);
    if(range.lower<request.minimum[index] || range.upper>request.maximum[index] || typeof raw.reason!=='string'
      || !['domain','stationary','resolution','continuum'].includes(raw.reason)) return invalid();
    return Object.freeze({axis,interval:range,reason:raw.reason});
  });
  if(typeof raw.exhaustive!=='boolean' || raw.exhaustive!==(unresolved.length===0)) return invalid();
  return Object.freeze({status:'ready',candidates:Object.freeze(candidates),exhaustive:raw.exhaustive,unresolved:Object.freeze(unresolved)});
}
export function decodeFunctionPointWorkReply(value:unknown,request:FunctionPointWorkRequest):FunctionPointWorkReply {
  const raw=functionWorkRecord(value,['kind','serial','identity','result']),identity=decodeMathRequestIdentity(raw.identity);
  if(raw.kind!=='function-points-result' || !sameMathIdentity(identity,request.identity)) return invalid();
  return Object.freeze({kind:'function-points-result',serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),identity,result:result(raw.result,request)});
}
