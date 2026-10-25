/** Synchronous math-Worker handler. The client also terminates the Worker on cancellation/deadline. */
import { MathInputProblem } from './mathInputContract.js';
import { geometryCalculationClock, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeFunctionCurveWorkEnvelope, FUNCTION_CURVE_LIMITS, type FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';
import { createFunctionCurveEvaluator } from './functionCurveEvaluation.js';
import { sampleFunctionCurve, type FunctionCurveEvaluator, type FunctionCurveSamplingResult } from './adaptiveFunctionCurve.js';
import type { MathRequestIdentity } from './mathWorkRequest.js';
import { exactFunctionCurveBezier, type FunctionCurveBezier } from './exactFunctionCurveBezier.js';
import { attachSmoothFunctionCurve, type SmoothFunctionCurve } from './smoothFunctionCurve.js';
import { requestPeriodicity, type FunctionCurvePeriodicity } from './functionCurvePeriodicity.js';
import { expectedFunctionCurveSeam } from './functionCurveTangentBounds.js';

export type FunctionCurveWorkResult = (FunctionCurveSamplingResult & { readonly bezier?: FunctionCurveBezier; readonly smooth?: SmoothFunctionCurve;
  /** Only when the request carried the original T bounds: the source-level periodic proof, or why it is unproved. */
  readonly periodicity?: FunctionCurvePeriodicity })
  | { readonly status: 'invalid'; readonly message: string };
export interface FunctionCurveWorkReply {
  readonly kind: 'function-curve-result'; readonly serial: number; readonly identity: MathRequestIdentity; readonly result: FunctionCurveWorkResult;
}
/**
 * A ready result gains the proof as information, and a proved closed smooth curve its seam bound computed from the
 * actual returned controls. Neither changes a sample, knot or pole.
 */
function withPeriodicity(result: FunctionCurveWorkResult, request: FunctionCurveWorkRequest, periodicity: FunctionCurvePeriodicity | undefined): FunctionCurveWorkResult {
  if (result.status !== 'ready' || periodicity === undefined) return result;
  const seam = result.smooth === undefined ? null
    : expectedFunctionCurveSeam(periodicity.status === 'proved', result.smooth.splines, request.lower, request.upper);
  const smooth = seam === null || result.smooth === undefined ? result.smooth : { ...result.smooth, seam };
  return { ...result, periodicity, ...(smooth === undefined ? {} : { smooth }) };
}
/**
 * Identify the end of a proved whole number of periods with its start BEFORE sampling. The sampler certifies every
 * returned point against the definition's enclosure at its own parameter, so the move from f(upper) to f(lower) is
 * charged to the chord bound and reaches the smooth error bound; nothing is snapped after certification.
 */
function periodicEvaluator<E extends FunctionCurveEvaluator>(evaluator: E, request: FunctionCurveWorkRequest, proved: boolean): E {
  return proved ? { ...evaluator, point: (parameter: number) => evaluator.point(parameter === request.upper ? request.lower : parameter) } : evaluator;
}
export function executeFunctionCurveWorkRequest(value: unknown, backend: MathExecutionBackend): FunctionCurveWorkReply {
  const { request, serial } = decodeFunctionCurveWorkEnvelope(value);
  const periodicity = requestPeriodicity(request), proved = periodicity?.status === 'proved';
  const reply = (result: FunctionCurveWorkResult): FunctionCurveWorkReply => ({ kind: 'function-curve-result', serial, identity: request.identity,
    result: withPeriodicity(result, request, periodicity) });
  const started = performance.now();
  const clock = geometryCalculationClock(backend, started), { shouldStop } = clock;
  try {
    const evaluator = periodicEvaluator(createFunctionCurveEvaluator(request.outputs, request.independent, request.coefficients,
      { backend: clock.backend, shouldStop }), request, proved);
    // The full-tolerance run is exactly the previous computation: same budgets, clock and errors.
    const sampled = sampleFunctionCurve(evaluator, { ...request, ...FUNCTION_CURVE_LIMITS, shouldStop });
    const bezier = sampled.status === 'ready' ? exactFunctionCurveBezier(request, () => shouldStop() !== undefined) : null;
    if (bezier !== null) return reply({ ...sampled, bezier });
    // Successful smooth geometry is deterministic; required refinement shares the original deadline.
    // The interval derivative adds the tangent certificate that the reply decoder recomputes.
    return reply(attachSmoothFunctionCurve(sampled, request.tolerance,
      (tolerance, stop) => sampleFunctionCurve(evaluator, { ...request, ...FUNCTION_CURVE_LIMITS, tolerance, shouldStop: stop }),
      { stop: () => clock.timeStopped() ? 'deadline' : undefined, derivative: evaluator.derivative, periodicSeam: proved }));
  } catch (error) {
    if (error instanceof MathInputProblem) return reply({ status: 'invalid', message: error.message });
    throw error;
  }
}
