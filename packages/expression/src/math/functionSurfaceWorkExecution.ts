import { MathInputProblem } from './mathInputContract.js';
import { geometryCalculationClock, type MathExecutionBackend } from './mathWorkExecution.js';
import type { MathRequestIdentity } from './mathWorkRequest.js';
import { decodeFunctionSurfaceWorkEnvelope } from './functionSurfaceWorkRequest.js';
import { createFunctionSurfaceEvaluator } from './functionSurfaceEvaluation.js';
import { sampleFunctionSurface, type FunctionSurfaceSamplingResult } from './adaptiveFunctionSurface.js';
import { proveFunctionSurfaceBoundary } from './functionSurfaceBoundary.js';

export type FunctionSurfaceWorkResult = FunctionSurfaceSamplingResult | { readonly status:'invalid'; readonly message:string };
export interface FunctionSurfaceWorkReply {
  readonly kind:'function-surface-result'; readonly serial:number; readonly identity:MathRequestIdentity; readonly result:FunctionSurfaceWorkResult;
}
export function executeFunctionSurfaceWorkRequest(value: unknown, backend: MathExecutionBackend): FunctionSurfaceWorkReply {
  const {request,serial} = decodeFunctionSurfaceWorkEnvelope(value);
  const reply = (result: FunctionSurfaceWorkResult): FunctionSurfaceWorkReply => ({kind:'function-surface-result',serial,identity:request.identity,result});
  const clock = geometryCalculationClock(backend, performance.now()), { shouldStop } = clock;
  try {
    const evaluator = createFunctionSurfaceEvaluator(request.outputs,request.independent,request.coefficients,{backend:clock.backend,shouldStop});
    const boundary = proveFunctionSurfaceBoundary(request,{backend:clock.backend,shouldStop});
    return reply(sampleFunctionSurface(evaluator,{...request,...request.budget,shouldStop,boundary}));
  } catch (error) {
    if (error instanceof MathInputProblem) return reply({status:'invalid',message:error.message});
    throw error;
  }
}
