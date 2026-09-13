import { MathInputProblem } from './mathInputContract.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { decodeFunctionImplicitCurveWorkEnvelope } from './functionImplicitCurveWorkRequest.js';
import type { FunctionImplicitCurveWorkReply,FunctionImplicitCurveWorkResult } from './functionImplicitCurveProtocol.js';
import { createFunctionImplicitEvaluator } from './functionImplicitEvaluation.js';
import { buildImplicitGrid } from './implicitGrid.js';
import { meshImplicitContours } from './implicitCurveSegments.js';

export function executeFunctionImplicitCurveWorkRequest(value:unknown,backend:MathExecutionBackend):FunctionImplicitCurveWorkReply {
  const {request,serial}=decodeFunctionImplicitCurveWorkEnvelope(value),started=performance.now();
  const shouldStop=()=>performance.now()-started>=2000?'deadline' as const:undefined;
  const reply=(result:FunctionImplicitCurveWorkResult):FunctionImplicitCurveWorkReply=>({kind:'function-implicit-curve-result',serial,identity:request.identity,result});
  try{
    const inputs=(['X','Y','Z'] as const).filter(axis=>axis!==request.fixedAxis);
    const evaluator=createFunctionImplicitEvaluator(request.expression,request.coefficients,{backend,shouldStop},inputs);
    const axis=request.fixedAxis==='X'?0:request.fixedAxis==='Y'?1:2;
    const grid=buildImplicitGrid(evaluator,{...request,...request.budget,maximumTriangles:request.budget.maximumSegments,shouldStop,
      fixed:{axis,coordinate:request.fixedCoordinate}});
    const stats={gridSamples:grid.samples,cells:grid.visited,vertices:0,segments:0};
    if(grid.status==='stopped') return reply({status:'stopped',reason:grid.reason,stats});
    if(grid.status!=='ready') return reply({status:grid.status,stats});
    const sampled=meshImplicitContours(grid.cells,{maximumVertices:request.budget.maximumSamples,maximumSegments:request.budget.maximumSegments,
      tolerance:request.tolerance,shouldStop,regularRegion:(minimum,maximum)=>evaluator.enclosure(minimum,maximum).continuous
        && evaluator.partials(minimum,maximum).some(value=>value!==null && (value.lower>0 || value.upper<0))});
    if(sampled.status==='stopped') return reply({status:'stopped',reason:sampled.reason,stats});
    if(sampled.components.length===0) return reply({status:'degenerate',stats});
    return reply({status:'ready',components:sampled.components,maximumDistanceBound:Math.max(grid.maximumCellDiameter,sampled.maximumCoverageDistance),
      stats:{...stats,vertices:sampled.vertices,segments:sampled.segments}});
  }catch(error){
    if(error instanceof MathInputProblem) return reply({status:'invalid',message:error.message});throw error;
  }
}
