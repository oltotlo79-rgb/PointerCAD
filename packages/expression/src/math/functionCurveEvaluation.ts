/** A curve uses the same parsed AST, coefficients, point VM and interval VM in one disposable Worker. */
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler, type ScalarInput } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarCurveCurvature, curveChordBound } from './scalarCurveCurvature.js';
import type { PreparedScalarMathContext } from './evaluatePreparedScalarMath.js';
import type { FunctionCurveEvaluator } from './adaptiveFunctionCurve.js';

export function createFunctionCurveEvaluator(outputs: readonly [unknown, unknown, unknown], independent: ScalarInput,
  coefficients: unknown, context: Omit<PreparedScalarMathContext, 'angleUnit'>): FunctionCurveEvaluator {
  const tapes = context.backend.withinDeadline(() => outputs.map(definition => compileFunctionScalar(definition, [independent], coefficients, context)));
  const points = tapes.map(createScalarSampler), ranges = tapes.map(createScalarIntervalSampler), curvatures = tapes.map(createScalarCurveCurvature);
  return {
    point: parameter => {
      const x = points[0]([parameter]), y = points[1]([parameter]), z = points[2]([parameter]);
      return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x, y, z] : null;
    },
    enclosure: (lower, upper) => {
      const interval = [{ lower, upper }];
      return [ranges[0](interval), ranges[1](interval), ranges[2](interval)];
    },
    chordErrorBound: (lower, upper) => curveChordBound(curvatures.map(curvature => curvature(lower, upper)), lower, upper),
  };
}
