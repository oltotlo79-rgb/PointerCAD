import {MathInputProblem} from './mathInputContract.js';
import {functionWorkCounter,functionWorkRecord} from './functionWorkData.js';
import {decodeSurfacePointWorkRequest,type SurfacePointWorkRequest,type SurfacePointCandidates} from './surfacePointWorkRequest.js';
import type {MathRequestIdentity} from './mathWorkRequest.js';

export type SurfacePointWorkResult=SurfacePointCandidates|{readonly status:'invalid';readonly message:string};
export interface SurfacePointWorkReply {
  readonly kind:'surface-points-result';readonly serial:number;readonly identity:MathRequestIdentity;readonly result:SurfacePointWorkResult;
}
export function decodeSurfacePointWorkEnvelope(value:unknown) {
  const raw=functionWorkRecord(value,['kind','serial','request']);
  if(raw.kind!=='solve-surface-points')throw new MathInputProblem('syntax','媒介曲面上の点の依頼の種類が不正です。');
  return Object.freeze({kind:'solve-surface-points' as const,serial:functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1),
    request:decodeSurfacePointWorkRequest(raw.request)});
}
export function createSurfacePointWorkEnvelope(serial:number,request:SurfacePointWorkRequest) {
  return decodeSurfacePointWorkEnvelope({kind:'solve-surface-points',serial,request});
}
