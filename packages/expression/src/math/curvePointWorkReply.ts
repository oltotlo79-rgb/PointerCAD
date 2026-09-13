/** No stale, malformed or out-of-domain candidate may enter a saved curve reference. */
import {MathInputProblem} from './mathInputContract.js';
import {functionWorkArray,functionWorkCounter,functionWorkNumber,functionWorkPoint,functionWorkRecord} from './functionWorkData.js';
import {functionPointAxis} from './functionPointWorkRequest.js';
import {decodeMathRequestIdentity} from './mathWorkRequest.js';
import {sameMathIdentity} from './mathWorkerClient.js';
import type {CurvePointWorkRequest,CurvePointCandidate} from './curvePointWorkRequest.js';
import type {CurvePointWorkReply,CurvePointWorkResult} from './curvePointWorkEnvelope.js';

const AXES=['X','Y','Z'] as const;
function invalid():never {throw new MathInputProblem('syntax','曲線上の点の結果と原式の座標・範囲を照合できません。');}
function interval(value:unknown,request:CurvePointWorkRequest) {
  const raw=functionWorkRecord(value,['lower','upper']),lower=functionWorkNumber(raw.lower),upper=functionWorkNumber(raw.upper);
  if(lower>upper || lower<request.lower || upper>request.upper || !Number.isFinite(upper-lower)) return invalid();
  return Object.freeze({lower,upper});
}
export function decodeCurvePointLocation(value:unknown,request:CurvePointWorkRequest):CurvePointCandidate['location'] {
  const location=functionWorkRecord(value,['kind','independent','interval','direct']);
  const range=interval(location.interval,request),direct=request.known.find(item=>item.axis===request.independent);
  if(location.kind!=='curve' || location.independent!==request.independent || location.direct!==(direct!==undefined)
    || range.upper-range.lower>request.tolerance || (direct!==undefined && (range.lower!==direct.value || range.upper!==direct.value))) return invalid();
  return Object.freeze({kind:'curve',independent:request.independent,interval:range,direct:direct!==undefined});
}
export function decodeCurvePointCandidate(value:unknown,request:CurvePointWorkRequest):CurvePointCandidate {
  const raw=functionWorkRecord(value,['point','minimum','maximum','location']),point=functionWorkPoint(raw.point);
  const minimum=functionWorkPoint(raw.minimum),maximum=functionWorkPoint(raw.maximum),location=decodeCurvePointLocation(raw.location,request),range=location.interval;
  if(point.some((value,axis)=>minimum[axis]>value || maximum[axis]<value || minimum[axis]<request.minimum[axis]
    || maximum[axis]>request.maximum[axis] || maximum[axis]-minimum[axis]>request.tolerance)) return invalid();
  if(request.known.some(item=>{const index=AXES.indexOf(item.axis);return point[index]!==item.value || minimum[index]!==item.value || maximum[index]!==item.value;})) return invalid();
  if(request.independent!=='T') {
    const index=AXES.indexOf(request.independent);
    if(minimum[index]!==range.lower || maximum[index]!==range.upper) return invalid();
  }
  return Object.freeze({point,minimum,maximum,location});
}
function result(value:unknown,request:CurvePointWorkRequest):CurvePointWorkResult {
  if(value===null || typeof value!=='object' || !('status' in value)) return invalid();
  if(value.status==='invalid') {
    const raw=functionWorkRecord(value,['status','message']);if(typeof raw.message!=='string' || raw.message.length<1 || raw.message.length>2048) return invalid();
    return Object.freeze({status:'invalid',message:raw.message});
  }
  if(value.status==='stopped') {
    const raw=functionWorkRecord(value,['status','reason']);if(raw.reason!=='cancelled' && raw.reason!=='deadline' && raw.reason!=='budget') return invalid();
    return Object.freeze({status:'stopped',reason:raw.reason});
  }
  if(value.status==='out-of-range') {
    const raw=functionWorkRecord(value,['status','axes']),axes=functionWorkArray(raw.axes,2).map(functionPointAxis);
    const outside=request.known.filter(item=>{const index=AXES.indexOf(item.axis);return item.value<request.minimum[index] || item.value>request.maximum[index];}).map(item=>item.axis);
    if(axes.length<1 || new Set(axes).size!==axes.length || axes.some(axis=>!outside.includes(axis)) || outside.some(axis=>!axes.includes(axis))) return invalid();
    return Object.freeze({status:'out-of-range',axes:Object.freeze(axes)});
  }
  if(value.status!=='ready') return invalid();
  const raw=functionWorkRecord(value,['status','candidates','exhaustive','unresolved']);
  const candidates=functionWorkArray(raw.candidates,1024).map(value=>decodeCurvePointCandidate(value,request));
  const unresolved=functionWorkArray(raw.unresolved,1024-candidates.length).map(value=>{
    const raw=functionWorkRecord(value,['interval','reason']),range=interval(raw.interval,request);
    if(typeof raw.reason!=='string' || !['domain','precision','condition','boundary','stationary','resolution','continuum'].includes(raw.reason)) return invalid();
    return Object.freeze({interval:range,reason:raw.reason});
  });
  if(typeof raw.exhaustive!=='boolean' || raw.exhaustive!==(unresolved.length===0)) return invalid();
  return Object.freeze({status:'ready',candidates:Object.freeze(candidates),unresolved:Object.freeze(unresolved),exhaustive:raw.exhaustive});
}
export function decodeCurvePointWorkReply(value:unknown,request:CurvePointWorkRequest):CurvePointWorkReply {
  const raw=functionWorkRecord(value,['kind','serial','identity','result']),identity=decodeMathRequestIdentity(raw.identity);
  if(raw.kind!=='curve-points-result' || !sameMathIdentity(identity,request.identity)) return invalid();
  return Object.freeze({kind:'curve-points-result',serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),identity,result:result(raw.result,request)});
}
