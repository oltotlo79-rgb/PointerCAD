import { MathInputProblem } from './mathInputContract.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { decodeFunctionImplicitWorkEnvelope } from './functionImplicitWorkRequest.js';
import { createFunctionImplicitEvaluator } from './functionImplicitEvaluation.js';
import { buildImplicitGrid } from './implicitGrid.js';
import { meshImplicitTetrahedra } from './implicitTetrahedra.js';
import type { FunctionImplicitWorkReply, FunctionImplicitWorkResult } from './functionImplicitProtocol.js';
import { tryImplicitPrimitive } from './tryImplicitPrimitive.js';
export function executeFunctionImplicitWorkRequest(value:unknown,backend:MathExecutionBackend):FunctionImplicitWorkReply {
  const {request,serial}=decodeFunctionImplicitWorkEnvelope(value),started=performance.now();
  const shouldStop=()=>performance.now()-started>=2000 ? 'deadline' as const : undefined;
  const reply=(result:FunctionImplicitWorkResult):FunctionImplicitWorkReply=>({kind:'function-implicit-surface-result',serial,identity:request.identity,result});
  try{
    const primitive=tryImplicitPrimitive(request,backend,()=>shouldStop()!==undefined);
    if(primitive!==null) return reply({status:'analytic',...primitive});
    const evaluator=createFunctionImplicitEvaluator(request.expression,request.coefficients,{backend,shouldStop});
    const grid=buildImplicitGrid(evaluator,{...request,...request.budget,shouldStop});
    const stats={gridSamples:grid.samples,cells:grid.visited,vertices:0,triangles:0};
    if(grid.status==='stopped') return reply({status:'stopped',reason:grid.reason,stats});
    if(grid.status!=='ready') return reply({status:grid.status,stats});
    const result=meshImplicitTetrahedra(grid.cells,{maximumVertices:request.budget.maximumSamples,maximumTriangles:request.budget.maximumTriangles,shouldStop,
      tolerance:request.tolerance,regularRegion:(minimum,maximum)=>evaluator.enclosure(minimum,maximum).continuous
        && evaluator.partials(minimum,maximum).some(value=>value!==null && (value.lower>0 || value.upper<0))});
    if(result.status==='stopped') return reply({status:'stopped',reason:result.reason,stats});
    if(result.mesh.triangles.length===0) return reply({status:'degenerate',stats});
    return reply({status:'ready',mesh:result.mesh,maximumDistanceBound:Math.max(grid.maximumCellDiameter,result.maximumCoverageDistance),
      stats:{...stats,vertices:result.mesh.vertices.length,triangles:result.mesh.triangles.length}});
  }catch(error){
    if(error instanceof MathInputProblem) return reply({status:'invalid',message:error.message});
    throw error;
  }
}
