/** Synchronous math-Worker handler. The client also terminates the Worker on cancellation/deadline. */
import { MathInputProblem } from './mathInputContract.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { decodeFunctionCurveWorkEnvelope, FUNCTION_CURVE_LIMITS } from './functionCurveWorkRequest.js';
import { createFunctionCurveEvaluator } from './functionCurveEvaluation.js';
import { sampleFunctionCurve, type FunctionCurveSamplingResult } from './adaptiveFunctionCurve.js';
import type { MathRequestIdentity } from './mathWorkRequest.js';
import { exactFunctionCurveBezier, type FunctionCurveBezier } from './exactFunctionCurveBezier.js';

export type FunctionCurveWorkResult = (FunctionCurveSamplingResult & { readonly bezier?: FunctionCurveBezier })
  | { readonly status: 'invalid'; readonly message: string };
export interface FunctionCurveWorkReply {
  readonly kind: 'function-curve-result'; readonly serial: number; readonly identity: MathRequestIdentity; readonly result: FunctionCurveWorkResult;
}
export function executeFunctionCurveWorkRequest(value: unknown, backend: MathExecutionBackend): FunctionCurveWorkReply {
  const { request, serial } = decodeFunctionCurveWorkEnvelope(value);
  const reply = (result: FunctionCurveWorkResult): FunctionCurveWorkReply => ({ kind: 'function-curve-result', serial, identity: request.identity, result });
  const started = performance.now();
  const shouldStop = () => performance.now() - started >= 2000 ? 'deadline' as const : undefined;
  try {
    const evaluator = createFunctionCurveEvaluator(request.outputs, request.independent, request.coefficients, { backend, shouldStop });
    const sampled = sampleFunctionCurve(evaluator, { ...request, ...FUNCTION_CURVE_LIMITS, shouldStop });
    const bezier = sampled.status === 'ready' ? exactFunctionCurveBezier(request, () => shouldStop() !== undefined) : null;
    return reply(bezier === null ? sampled : { ...sampled, bezier });
  } catch (error) {
    if (error instanceof MathInputProblem) return reply({ status: 'invalid', message: error.message });
    throw error;
  }
}
