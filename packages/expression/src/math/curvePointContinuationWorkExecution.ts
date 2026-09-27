/** Point branch and differential geometry share the disposable Worker's deadline. */
import {MathInputProblem} from './mathInputContract.js';
import {functionWorkCounter,functionWorkRecord} from './functionWorkData.js';
import {decodeCurvePointContinuationWorkRequest,type CurvePointContinuationWorkResult} from './curvePointContinuationWork.js';
import {continueCurveFunctionPoint} from './continueCurveFunctionPoint.js';
import {applyFunctionPointDirection} from './applyFunctionPointDirection.js';
import {geometryCalculationClock,type MathExecutionBackend} from './mathWorkExecution.js';

export function executeCurvePointContinuationWork(value:unknown,backend:MathExecutionBackend) {
  const raw=functionWorkRecord(value,['kind','serial','request']);
  if(raw.kind!=='continue-curve-point')throw new MathInputProblem('syntax','関数上の点の追従条件を確認できません。');
  const request=decodeCurvePointContinuationWorkRequest(raw.request),serial=functionWorkCounter(raw.serial,Number.MAX_SAFE_INTEGER,1);
  const clock=geometryCalculationClock(backend,performance.now()),{shouldStop}=clock;
  const reply=(result:CurvePointContinuationWorkResult)=>({kind:'curve-point-continuation-result' as const,serial,identity:request.identity,result});
  try{return reply(clock.settle(clock.run(()=>{
    const current={...request.current,identity:request.identity},context={backend:clock.backend,shouldStop};
    const result=continueCurveFunctionPoint({...request.previous,identity:request.identity},current,request.anchor,context);
    if(result.status!=='ready')return result;
    const endpoint=applyFunctionPointDirection(current,result.candidate,request.direction,context);
    return {...result,...(endpoint?{endpoint}:{})};
  })));}catch(error){
    if(!(error instanceof MathInputProblem))throw error;
    return reply(clock.timeStopped()?{status:'stopped',reason:'deadline'}
      :clock.stopped(error)??{status:'invalid',message:error.message});
  }
}
