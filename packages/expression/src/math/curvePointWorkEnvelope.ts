import {MathInputProblem} from './mathInputContract.js';
import {functionWorkCounter,functionWorkRecord} from './functionWorkData.js';
import {decodeCurvePointWorkRequest,type CurvePointWorkRequest,type CurvePointCandidates} from './curvePointWorkRequest.js';
import type {MathRequestIdentity} from './mathWorkRequest.js';

export type CurvePointWorkResult=CurvePointCandidates|{readonly status:'invalid';readonly message:string};
export interface CurvePointWorkReply {
  readonly kind:'curve-points-result';readonly serial:number;readonly identity:MathRequestIdentity;readonly result:CurvePointWorkResult;
}
export function decodeCurvePointWorkEnvelope(value:unknown) {
  const raw=functionWorkRecord(value,['kind','serial','request']);
  if(raw.kind!=='solve-curve-points') throw new MathInputProblem('syntax','曲線上の点の依頼の種類が不正です。');
  return Object.freeze({kind:'solve-curve-points' as const,serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),
    request:decodeCurvePointWorkRequest(raw.request)});
}
export function createCurvePointWorkEnvelope(serial:number,request:CurvePointWorkRequest) {
  return decodeCurvePointWorkEnvelope({kind:'solve-curve-points',serial,request});
}
