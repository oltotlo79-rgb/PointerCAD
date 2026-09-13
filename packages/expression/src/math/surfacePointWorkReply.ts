/** A reply cannot change the original XYZ constraints or the independent U/V domain. */
import {MathInputProblem} from './mathInputContract.js';
import {functionWorkArray,functionWorkCounter,functionWorkNumber,functionWorkPoint,functionWorkRecord} from './functionWorkData.js';
import {functionPointAxis} from './functionPointWorkRequest.js';
import {decodeMathRequestIdentity} from './mathWorkRequest.js';
import {sameMathIdentity} from './mathWorkerClient.js';
import type {SurfacePointWorkRequest,SurfacePointCandidate} from './surfacePointWorkRequest.js';
import type {SurfacePointWorkReply,SurfacePointWorkResult} from './surfacePointWorkEnvelope.js';
import type {ParameterBox} from './bivariateIntervalNewton.js';

const AXES=['X','Y','Z'] as const;
function invalid():never {throw new MathInputProblem('syntax','媒介曲面上の点の結果と原式の座標・U/V範囲を照合できません。');}
function parameterBox(value:unknown,request:SurfacePointWorkRequest):ParameterBox {
  const entries=functionWorkArray(value,2);if(entries.length!==2)return invalid();
  const ranges=entries.map((value,index)=>{
    const raw=functionWorkRecord(value,['lower','upper']),lower=functionWorkNumber(raw.lower),upper=functionWorkNumber(raw.upper);
    if(lower>upper||lower<request.lower[index]||upper>request.upper[index]||!Number.isFinite(upper-lower))return invalid();
    return Object.freeze({lower,upper});
  });
  return Object.freeze([ranges[0],ranges[1]] as const);
}
export function decodeSurfacePointLocation(value:unknown,request:SurfacePointWorkRequest):SurfacePointCandidate['location'] {
  const location=functionWorkRecord(value,['kind','box']),box=parameterBox(location.box,request);
  if(location.kind!=='parametric-surface'||request.known.length===2&&box.some(range=>range.upper-range.lower>request.tolerance))return invalid();
  return Object.freeze({kind:'parametric-surface',box});
}
export function decodeSurfacePointCandidate(value:unknown,request:SurfacePointWorkRequest):SurfacePointCandidate {
  const raw=functionWorkRecord(value,['point','minimum','maximum','location']),point=functionWorkPoint(raw.point);
  const minimum=functionWorkPoint(raw.minimum),maximum=functionWorkPoint(raw.maximum),location=decodeSurfacePointLocation(raw.location,request);
  if(point.some((value,axis)=>minimum[axis]>value||maximum[axis]<value||minimum[axis]<request.minimum[axis]
    ||maximum[axis]>request.maximum[axis]||maximum[axis]-minimum[axis]>request.tolerance))return invalid();
  if(request.known.some(item=>{const index=AXES.indexOf(item.axis);return point[index]!==item.value||minimum[index]!==item.value||maximum[index]!==item.value;}))return invalid();
  return Object.freeze({point,minimum,maximum,location});
}
function result(value:unknown,request:SurfacePointWorkRequest):SurfacePointWorkResult {
  if(value===null||typeof value!=='object'||!('status' in value))return invalid();
  if(value.status==='invalid'){
    const raw=functionWorkRecord(value,['status','message']);if(typeof raw.message!=='string'||raw.message.length<1||raw.message.length>2048)return invalid();
    return Object.freeze({status:'invalid',message:raw.message});
  }
  if(value.status==='stopped'){
    const raw=functionWorkRecord(value,['status','reason']);if(raw.reason!=='cancelled'&&raw.reason!=='deadline'&&raw.reason!=='budget')return invalid();
    return Object.freeze({status:'stopped',reason:raw.reason});
  }
  if(value.status==='underconstrained'){
    functionWorkRecord(value,['status']);if(request.known.length!==1)return invalid();return Object.freeze({status:'underconstrained'});
  }
  if(value.status==='out-of-range'){
    const raw=functionWorkRecord(value,['status','axes']),axes=functionWorkArray(raw.axes,2).map(functionPointAxis);
    const outside=request.known.filter(item=>{const index=AXES.indexOf(item.axis);return item.value<request.minimum[index]||item.value>request.maximum[index];}).map(item=>item.axis);
    if(axes.length<1||new Set(axes).size!==axes.length||axes.some(axis=>!outside.includes(axis))||outside.some(axis=>!axes.includes(axis)))return invalid();
    return Object.freeze({status:'out-of-range',axes:Object.freeze(axes)});
  }
  if(value.status!=='ready')return invalid();
  const raw=functionWorkRecord(value,['status','candidates','exhaustive','unresolved']);
  const candidates=functionWorkArray(raw.candidates,1024).map(value=>decodeSurfacePointCandidate(value,request));
  const unresolved=functionWorkArray(raw.unresolved,1024-candidates.length).map(value=>{
    const raw=functionWorkRecord(value,['box','reason']),box=parameterBox(raw.box,request);
    if(typeof raw.reason!=='string'||!['domain','singular','resolution','continuum','precision','boundary','stationary',
      'free-parameter','free-parameters','two-parameter-coordinate'].includes(raw.reason))return invalid();
    return Object.freeze({box,reason:raw.reason});
  });
  if(typeof raw.exhaustive!=='boolean'||raw.exhaustive!==(unresolved.length===0))return invalid();
  return Object.freeze({status:'ready',candidates:Object.freeze(candidates),unresolved:Object.freeze(unresolved),exhaustive:raw.exhaustive});
}
export function decodeSurfacePointWorkReply(value:unknown,request:SurfacePointWorkRequest):SurfacePointWorkReply {
  const raw=functionWorkRecord(value,['kind','serial','identity','result']),identity=decodeMathRequestIdentity(raw.identity);
  if(raw.kind!=='surface-points-result'||!sameMathIdentity(identity,request.identity))return invalid();
  return Object.freeze({kind:'surface-points-result',serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),identity,result:result(raw.result,request)});
}
