/** Recognize an exact polynomial, never fit a smooth curve through arbitrary sampled corners. Worker only. */
import { exactParameterEquation } from './exactParameterEquation.js';
import { exactDouble, exactDoubleInterval } from './exactDoubleInterval.js';
import { exactAdd, exactDivide, exactMultiply, exactNegative } from './exactCoordinatePolynomial.js';
import { createExactPolynomialArithmetic } from './exactScalarPolynomial.js';
import type { ExactRational } from './exactRational.js';
import type { FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';
import type { FunctionCurvePoint } from './adaptiveFunctionCurve.js';

export type FunctionCurveBezier = readonly [FunctionCurvePoint, FunctionCurvePoint, FunctionCurvePoint, FunctionCurvePoint];

/** Cubic Hermite to Bernstein conversion is exact for degree <= 3, including degree elevation. */
export function exactFunctionCurveBezier(input: FunctionCurveWorkRequest, stop: () => boolean): FunctionCurveBezier | null {
  const exhausted = new Error('Polynomial recognition budget');
  let operations = 1000;
  const check = () => { if (--operations < 0 || stop()) throw exhausted; };
  const require = (value: ExactRational | null): ExactRational => { check(); if (value === null) throw exhausted; return value; };
  try {
    const lower = require(exactDouble(input.lower)), upper = require(exactDouble(input.upper));
    const thirdSpan = require(exactDivide(require(exactAdd(upper, exactNegative(lower))), { numerator: 3n, denominator: 1n }));
    const arithmetic = createExactPolynomialArithmetic(check, () => { throw exhausted; });
    const coordinates: number[][] = [];
    for (let axis = 0; axis < 3; axis++) {
      const polynomial = exactParameterEquation(input.outputs[axis].expression, input.independent, input.coefficients, 0, stop);
      if (polynomial === null || polynomial.length > 4) return null;
      const derivative = arithmetic.derivative(polynomial);
      const first = arithmetic.evaluate(polynomial, lower), last = arithmetic.evaluate(polynomial, upper);
      const poles = [first, require(exactAdd(first, require(exactMultiply(thirdSpan, arithmetic.evaluate(derivative, lower))))),
        require(exactAdd(last, exactNegative(require(exactMultiply(thirdSpan, arithmetic.evaluate(derivative, upper)))))), last];
      const values: number[] = [];
      for (const pole of poles) {
        const interval = exactDoubleInterval(pole);
        // A convex enclosure proves the entire curve is inside all XYZ ranges. Crossing curves
        // keep the certified chord/clipping route; control points are never clamped to the box.
        if (interval === null || interval.lower < input.minimum[axis] || interval.upper > input.maximum[axis]
          || interval.upper - interval.lower > input.tolerance / 16) return null;
        values.push(interval.lower);
      }
      coordinates.push(values);
    }
    const point = (index: number): FunctionCurvePoint => Object.freeze([coordinates[0][index], coordinates[1][index], coordinates[2][index]]);
    const result: FunctionCurveBezier = Object.freeze([point(0), point(1), point(2), point(3)]);
    // Closed/collapsed parameterizations retain their existing topology classification.
    return stop() || result[0].every((value, axis) => value === result[3][axis]) ? null : result;
  } catch (error) { if (error === exhausted) return null; throw error; }
}
