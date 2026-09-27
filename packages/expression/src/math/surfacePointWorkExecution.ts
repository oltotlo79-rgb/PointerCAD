import {MathInputProblem} from './mathInputContract.js';
import {decodeSurfacePointWorkEnvelope,type SurfacePointWorkReply,type SurfacePointWorkResult} from './surfacePointWorkEnvelope.js';
import {solveSurfaceFunctionPoints} from './solveSurfaceFunctionPoints.js';
import {geometryCalculationClock,type MathExecutionBackend} from './mathWorkExecution.js';

export function executeSurfacePointWorkRequest(value:unknown,backend:MathExecutionBackend):SurfacePointWorkReply {
  const {request,serial}=decodeSurfacePointWorkEnvelope(value),started=performance.now();
  const clock=geometryCalculationClock(backend,started),{shouldStop}=clock;
  const reply=(result:SurfacePointWorkResult):SurfacePointWorkReply=>({kind:'surface-points-result',serial,identity:request.identity,result});
  try {return reply(clock.settle(clock.run(()=>solveSurfaceFunctionPoints(request,{backend:clock.backend,shouldStop}))));}
  catch(error){
    if(error instanceof MathInputProblem)return reply(clock.stopped(error)??{status:'invalid',message:error.message});
    throw error;
  }
}
