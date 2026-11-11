import { MathInputProblem, pacedCalculationMs } from './mathInputContract.js';
import { GEOMETRY_CALCULATION_MS, geometryCalculationClock, type MathExecutionBackend } from './mathWorkExecution.js';
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
/**
 * A busy machine can let the request's wall clock stop a stage that fits its limits (2026-11-10 CI: the certified mesh
 * was complete and 64% of the smoothing certificate was done when the paced 2,000ms clock ended). As for ordinary
 * expressions (exactMathWorkExecution.ts), only such a stop, never a size, step or rounding limit, is calculated once
 * more, at most once per request: the stopped stage alone runs again on a new clock of the same paced length that
 * starts where the first one ended, so the request always ends within twice that length. A second stop is the time
 * limit ('deadline') as before. Cancellation ends the whole Worker and is never calculated again.
 */
function surfaceClock(backend: MathExecutionBackend) {
  const started = performance.now();
  let clock = geometryCalculationClock(backend, started), recalculated = false;
  const watched: MathExecutionBackend = { ...backend,
    withinDeadline: <T>(operation: () => T extends Promise<unknown> ? never : T, allowance?: number): T =>
      clock.backend.withinDeadline<T>(operation, allowance) };
  return {
    backend: watched,
    shouldStop: (): 'deadline' | undefined => clock.shouldStop(),
    /** True, with the clock started again, only for this request's first wall-clock stop. */
    recalculate(reason: string): boolean {
      if (recalculated || reason !== 'deadline') return false;
      recalculated = true;
      clock = geometryCalculationClock(backend, Math.min(performance.now(), started + pacedCalculationMs(GEOMETRY_CALCULATION_MS)));
      return true;
    },
  };
}
export function executeFunctionSurfaceWorkRequest(value: unknown, backend: MathExecutionBackend): FunctionSurfaceWorkReply {
  const {request,serial} = decodeFunctionSurfaceWorkEnvelope(value);
  const reply = (result: FunctionSurfaceWorkResult): FunctionSurfaceWorkReply => ({kind:'function-surface-result',serial,identity:request.identity,result});
  const clock = surfaceClock(backend), { shouldStop } = clock;
  try {
    const evaluator = createFunctionSurfaceEvaluator(request.outputs,request.independent,request.coefficients,{backend:clock.backend,shouldStop});
    const boundary = proveFunctionSurfaceBoundary(request,{backend:clock.backend,shouldStop});
    const capture: { value?: { readonly leaves: readonly SurfaceLeaf[]; readonly parameter: (index: number, axis: 0 | 1) => number;
      readonly knownSample: FunctionSurfaceSampleLookup } } = {};
    const sample = (): FunctionSurfaceSamplingResult => sampleFunctionSurface(evaluator,{...request,...request.budget,shouldStop,boundary},
      { leaves: (leaves, parameter, knownSample) => { capture.value = { leaves, parameter, knownSample }; } });
    let sampled = sample();
    // Only the clock's first stop samples again; size, step, rounding, empty and degenerate results are final.
    if (sampled.status === 'stopped' && clock.recalculate(sampled.reason)) { capture.value = undefined; sampled = sample(); }
    if (sampled.status !== 'ready') return reply(sampled);
    const ready = sampled, captured = capture.value;
    // Conditions, cuts, seams and poles keep the certified mesh only; they are never drawn across.
    if (captured === undefined) return reply({ ...ready, splineDeclined: 'topology' });
    // Smoothing spends what sampling left of the same request budget; nothing is reset for the second pass.
    const smoothOnce = () => smoothFunctionSurface(evaluator, captured.leaves, { minimum: request.minimum, maximum: request.maximum,
      tolerance: request.tolerance, parameter: captured.parameter, knownSample: captured.knownSample,
      remainingSamples: request.budget.maximumSamples - ready.stats.samples, remainingCells: request.budget.maximumCells - ready.stats.cells,
      mesh: { vertices: ready.vertices, triangles: ready.triangles, bound: ready.maximumInterpolationErrorBound },
      stop: () => shouldStop() !== undefined });
    let smooth = smoothOnce();
    // Smoothing stops only for this request's clock; its first stop smooths the same certified mesh once more.
    if (smooth.status === 'stopped' && clock.recalculate(shouldStop() ?? 'deadline')) smooth = smoothOnce();
    const stats = Object.freeze({ ...ready.stats, samples: ready.stats.samples + smooth.used.samples, cells: ready.stats.cells + smooth.used.cells });
    // A stop during smoothing is the request's own clock or cancellation: report it, never hide it behind the mesh.
    if (smooth.status === 'stopped') return reply({ status: 'stopped', reason: shouldStop() ?? 'deadline', stats });
    return reply(smooth.status === 'ready' ? { ...ready, stats, spline: smooth.spline } : { ...ready, stats, splineDeclined: smooth.reason });
  } catch (error) {
    if (error instanceof MathInputProblem) return reply({status:'invalid',message:error.message});
    throw error;
  }
}
