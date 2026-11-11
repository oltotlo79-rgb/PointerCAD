/** A curve uses the same parsed AST, coefficients, point VM and interval VM in one disposable Worker. */
import { compileFunctionScalar } from './compileFunctionScalar.js';
import { createScalarSampler, type ScalarInput } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarCurveCurvature, createScalarFirstDerivatives, curveChordBound } from './scalarCurveCurvature.js';
import type { PreparedScalarMathContext } from './evaluatePreparedScalarMath.js';
import type { FunctionCurveEvaluator } from './adaptiveFunctionCurve.js';
import type { FunctionCurveDerivative } from './functionCurveTangentBounds.js';

export function createFunctionCurveEvaluator(outputs: readonly [unknown, unknown, unknown], independent: ScalarInput,
  coefficients: unknown, context: Omit<PreparedScalarMathContext, 'angleUnit'>): FunctionCurveEvaluator & { readonly derivative: FunctionCurveDerivative } {
  const tapes = context.backend.withinDeadline(() => outputs.map(definition => compileFunctionScalar(definition, [independent], coefficients, context)));
  const points = tapes.map(createScalarSampler), ranges = tapes.map(createScalarIntervalSampler), curvatures = tapes.map(createScalarCurveCurvature);
  // The same interval jet as the curvature bound, first order only: d/dparameter of each coordinate.
  const slopes = tapes.map(tape => createScalarFirstDerivatives(tape, [[1]]));
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
    derivative: (lower, upper) => {
      const interval = [{ lower, upper }];
      return [slopes[0](interval)[0], slopes[1](interval)[0], slopes[2](interval)[0]];
    },
  };
}
