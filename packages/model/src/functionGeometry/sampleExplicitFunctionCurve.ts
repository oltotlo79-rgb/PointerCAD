/** Worker-side connection from persistent definitions/current ranges to the shared curve sampler. */
import {
  createFunctionCurveEvaluator,
  sampleFunctionCurve,
  type FunctionCurveSamplingResult,
} from '@pointercad/expression/math/geometry';

import type { MathExecutionBackend } from '@pointercad/expression/math/worker';
import { FUNCTION_CURVE_LIMITS } from '@pointercad/expression/math/contracts';
import { functionCurveRequest, type ExplicitFunctionCurveFormula, type FunctionCurveRequestContext } from './functionCurveRequest.js';
import type { ResolvedFunctionRanges } from './resolveFunctionRanges.js';

export type { ExplicitFunctionCurveFormula } from './functionCurveRequest.js';
export interface ExplicitFunctionCurveContext extends FunctionCurveRequestContext {
  readonly backend: MathExecutionBackend;
  readonly shouldStop: () => 'cancelled' | 'deadline' | undefined;
}

/** No persisted range cache or implicit Z default is read here. XYZ comes from the current validated ranges. */
export function sampleExplicitFunctionCurve(formula: ExplicitFunctionCurveFormula, ranges: ResolvedFunctionRanges,
  context: ExplicitFunctionCurveContext): FunctionCurveSamplingResult {
  const stop = context.shouldStop();
  if (stop !== undefined) return { status: 'stopped', reason: stop, stats: { samples: 0, cells: 0 } };
  const request = functionCurveRequest(formula, ranges, context);
  return sampleFunctionCurve(createFunctionCurveEvaluator(request.outputs, request.independent, request.coefficients, context),
    { ...request, ...FUNCTION_CURVE_LIMITS, shouldStop: context.shouldStop });
}
