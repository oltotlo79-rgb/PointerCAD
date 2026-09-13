import {MathInputProblem} from './mathInputContract.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';
import type {MathRequestIdentity} from './mathWorkRequest.js';
import {decodeFunctionPointWorkEnvelope} from './functionPointWorkRequest.js';
import {solveImplicitFunctionPoints} from './solveImplicitFunctionPoints.js';
import type {FunctionPointCandidates} from './functionPointCandidates.js';

export type FunctionPointWorkResult=FunctionPointCandidates|{readonly status:'invalid';readonly message:string};
export interface FunctionPointWorkReply {
  readonly kind:'function-points-result';readonly serial:number;readonly identity:MathRequestIdentity;readonly result:FunctionPointWorkResult;
}
export function executeFunctionPointWorkRequest(value:unknown,backend:MathExecutionBackend):FunctionPointWorkReply {
  const {request,serial}=decodeFunctionPointWorkEnvelope(value),started=performance.now();
  const shouldStop=()=>performance.now()-started>=2000?'deadline' as const:undefined;
  const reply=(result:FunctionPointWorkResult):FunctionPointWorkReply=>({kind:'function-points-result',serial,identity:request.identity,result});
  try {
    return reply(backend.withinDeadline(()=>solveImplicitFunctionPoints(request,{backend,shouldStop})));
  } catch(error) {
    if(error instanceof MathInputProblem) return reply(error.code==='budget'?{status:'stopped',reason:'budget'}:{status:'invalid',message:error.message});
    throw error;
  }
}
