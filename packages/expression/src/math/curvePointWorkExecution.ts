import {MathInputProblem} from './mathInputContract.js';
import {decodeCurvePointWorkEnvelope,type CurvePointWorkReply,type CurvePointWorkResult} from './curvePointWorkEnvelope.js';
import {solveCurveFunctionPoints} from './solveCurveFunctionPoints.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

export function executeCurvePointWorkRequest(value:unknown,backend:MathExecutionBackend):CurvePointWorkReply {
  const {request,serial}=decodeCurvePointWorkEnvelope(value),started=performance.now();
  const shouldStop=()=>performance.now()-started>=2000?'deadline' as const:undefined;
  const reply=(result:CurvePointWorkResult):CurvePointWorkReply=>({kind:'curve-points-result',serial,identity:request.identity,result});
  try {return reply(backend.withinDeadline(()=>solveCurveFunctionPoints(request,{backend,shouldStop})));}
  catch(error) {
    if(error instanceof MathInputProblem) return reply(error.code==='budget'?{status:'stopped',reason:'budget'}:{status:'invalid',message:error.message});
    throw error;
  }
}
