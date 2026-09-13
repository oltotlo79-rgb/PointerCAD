/** Point branch and differential geometry share the disposable Worker's deadline. */
import {MathInputProblem} from './mathInputContract.js';
import {functionWorkCounter,functionWorkRecord} from './functionWorkData.js';
import {decodeSurfacePointContinuationWorkRequest,type SurfacePointContinuationWorkResult} from './surfacePointContinuationWork.js';
import {continueSurfaceFunctionPoint} from './continueSurfaceFunctionPoint.js';
import {applyFunctionPointDirection} from './applyFunctionPointDirection.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

export function executeSurfacePointContinuationWork(value:unknown,backend:MathExecutionBackend) {
  const raw=functionWorkRecord(value,['kind','serial','request']);
  if(raw.kind!=='continue-surface-point')throw new MathInputProblem('syntax','関数上の点の追従条件を確認できません。');
  const request=decodeSurfacePointContinuationWorkRequest(raw.request),serial=functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1);
  const started=performance.now(),shouldStop=()=>performance.now()-started>=2000?'deadline' as const:undefined;
  const reply=(result:SurfacePointContinuationWorkResult)=>({kind:'surface-point-continuation-result' as const,serial,identity:request.identity,result});
  try{return reply(backend.withinDeadline(()=>{
    const current={...request.current,identity:request.identity},context={backend,shouldStop};
    const result=continueSurfaceFunctionPoint({...request.previous,identity:request.identity},current,request.anchor,context);
    if(result.status!=='ready')return result;
    const endpoint=applyFunctionPointDirection(current,result.candidate,request.direction,context);
    return {...result,...(endpoint?{endpoint}:{})};
  }));}catch(error){
    if(!(error instanceof MathInputProblem))throw error;
    const stopped=shouldStop();return reply(stopped?{status:'stopped',reason:stopped}
      :error.code==='budget'?{status:'stopped',reason:'budget'}:{status:'invalid',message:error.message});
  }
}
