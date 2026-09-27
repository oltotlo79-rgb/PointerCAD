import {MathInputProblem} from './mathInputContract.js';
import {decodeCurvePointWorkEnvelope,type CurvePointWorkReply,type CurvePointWorkResult} from './curvePointWorkEnvelope.js';
import {solveCurveFunctionPoints} from './solveCurveFunctionPoints.js';
import {geometryCalculationClock,type MathExecutionBackend} from './mathWorkExecution.js';

export function executeCurvePointWorkRequest(value:unknown,backend:MathExecutionBackend):CurvePointWorkReply {
  const {request,serial}=decodeCurvePointWorkEnvelope(value),started=performance.now();
  const clock=geometryCalculationClock(backend,started),{shouldStop}=clock;
  const reply=(result:CurvePointWorkResult):CurvePointWorkReply=>({kind:'curve-points-result',serial,identity:request.identity,result});
  try {return reply(clock.settle(clock.run(()=>solveCurveFunctionPoints(request,{backend:clock.backend,shouldStop}))));}
  catch(error) {
    if(error instanceof MathInputProblem) return reply(clock.stopped(error)??{status:'invalid',message:error.message});
    throw error;
  }
}
