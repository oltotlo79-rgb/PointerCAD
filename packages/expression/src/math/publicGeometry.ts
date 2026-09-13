/** Worker-owned bounded curve and surface evaluation without creating a symbolic engine. */
export {
  createFunctionCurveEvaluator,
} from './functionCurveEvaluation.js';
export {
  sampleFunctionCurve,
} from './adaptiveFunctionCurve.js';
export type {
  FunctionCurveSamplingResult,
} from './adaptiveFunctionCurve.js';
export {
  createFunctionSurfaceEvaluator,
} from './functionSurfaceEvaluation.js';
