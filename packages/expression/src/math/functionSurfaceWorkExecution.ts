import { MathInputProblem } from './mathInputContract.js';
import { geometryCalculationClock, type MathExecutionBackend } from './mathWorkExecution.js';
import type { MathRequestIdentity } from './mathWorkRequest.js';
import { decodeFunctionSurfaceWorkEnvelope } from './functionSurfaceWorkRequest.js';
import { createFunctionSurfaceEvaluator } from './functionSurfaceEvaluation.js';
import { sampleFunctionSurface, type FunctionSurfaceSamplingResult, type FunctionSurfaceSampleLookup } from './adaptiveFunctionSurface.js';
import { proveFunctionSurfaceBoundary } from './functionSurfaceBoundary.js';
import { smoothFunctionSurface, type FunctionSurfaceSpline } from './smoothFunctionSurface.js';
import type { SurfaceLeaf } from './surfaceParameterGrid.js';

/** Why a certified triangle mesh did not also receive a certified smooth spline. */
export type FunctionSurfaceSplineDeclined = 'topology' | 'coverage' | 'budget' | 'samples' | 'bound' | 'affine';
export type FunctionSurfaceWorkResult = (FunctionSurfaceSamplingResult & {
  readonly spline?: FunctionSurfaceSpline; readonly splineDeclined?: FunctionSurfaceSplineDeclined;
}) | { readonly status:'invalid'; readonly message:string };
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
    const capture: { value?: { readonly leaves: readonly SurfaceLeaf[]; readonly parameter: (index: number, axis: 0 | 1) => number;
      readonly knownSample: FunctionSurfaceSampleLookup } } = {};
    const sampled = sampleFunctionSurface(evaluator,{...request,...request.budget,shouldStop,boundary},
      { leaves: (leaves, parameter, knownSample) => { capture.value = { leaves, parameter, knownSample }; } });
    if (sampled.status !== 'ready') return reply(sampled);
    const captured = capture.value;
    // Conditions, cuts, seams and poles keep the certified mesh only; they are never drawn across.
    if (captured === undefined) return reply({ ...sampled, splineDeclined: 'topology' });
    // Smoothing spends what sampling left of the same request budget; nothing is reset for the second pass.
    const smooth = smoothFunctionSurface(evaluator, captured.leaves, { minimum: request.minimum, maximum: request.maximum,
      tolerance: request.tolerance, parameter: captured.parameter, knownSample: captured.knownSample,
      remainingSamples: request.budget.maximumSamples - sampled.stats.samples, remainingCells: request.budget.maximumCells - sampled.stats.cells,
      mesh: { vertices: sampled.vertices, triangles: sampled.triangles, bound: sampled.maximumInterpolationErrorBound },
      stop: () => shouldStop() !== undefined });
    const stats = Object.freeze({ ...sampled.stats, samples: sampled.stats.samples + smooth.used.samples, cells: sampled.stats.cells + smooth.used.cells });
    // A stop during smoothing is the request's own clock or cancellation: report it, never hide it behind the mesh.
    if (smooth.status === 'stopped') return reply({ status: 'stopped', reason: shouldStop() ?? 'deadline', stats });
    return reply(smooth.status === 'ready' ? { ...sampled, stats, spline: smooth.spline } : { ...sampled, stats, splineDeclined: smooth.reason });
  } catch (error) {
    if (error instanceof MathInputProblem) return reply({status:'invalid',message:error.message});
    throw error;
  }
}
