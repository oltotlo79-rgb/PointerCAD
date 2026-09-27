import {MathInputProblem} from './mathInputContract.js';
import {geometryCalculationClock,type MathExecutionBackend} from './mathWorkExecution.js';
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
  const clock=geometryCalculationClock(backend,started),{shouldStop}=clock;
  const reply=(result:FunctionPointWorkResult):FunctionPointWorkReply=>({kind:'function-points-result',serial,identity:request.identity,result});
  try {
    return reply(clock.settle(clock.run(()=>solveImplicitFunctionPoints(request,{backend:clock.backend,shouldStop}))));
  } catch(error) {
    if(error instanceof MathInputProblem) return reply(clock.stopped(error)??{status:'invalid',message:error.message});
    throw error;
  }
}
