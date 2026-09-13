import {MathInputProblem} from './mathInputContract.js';
import {decodeSurfacePointWorkEnvelope,type SurfacePointWorkReply,type SurfacePointWorkResult} from './surfacePointWorkEnvelope.js';
import {solveSurfaceFunctionPoints} from './solveSurfaceFunctionPoints.js';
import type {MathExecutionBackend} from './mathWorkExecution.js';

export function executeSurfacePointWorkRequest(value:unknown,backend:MathExecutionBackend):SurfacePointWorkReply {
  const {request,serial}=decodeSurfacePointWorkEnvelope(value),started=performance.now();
  const shouldStop=()=>performance.now()-started>=2000?'deadline' as const:undefined;
  const reply=(result:SurfacePointWorkResult):SurfacePointWorkReply=>({kind:'surface-points-result',serial,identity:request.identity,result});
  try {return reply(backend.withinDeadline(()=>solveSurfaceFunctionPoints(request,{backend,shouldStop})));}
  catch(error){
    if(error instanceof MathInputProblem)return reply(error.code==='budget'?{status:'stopped',reason:'budget'}:{status:'invalid',message:error.message});
    throw error;
  }
}
